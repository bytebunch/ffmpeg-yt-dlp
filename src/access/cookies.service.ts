import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { isUuid, uuidv7 } from '../common/ids';
import { decryptSecret, encryptSecret } from '../common/secrets';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type CookieJar, cookieJars } from '../db/schema';
import { hasControlCharacters } from '../recipes/values';
import { COOKIES_MAX_BYTES, parseCookieFile } from './cookie-file';
import type { CookiesRef } from './options';

export const COOKIE_JARS_MAX = 20;

export const cookiesBody = z.strictObject({
  cookies: z
    .string()
    .min(1)
    .max(COOKIES_MAX_BYTES)
    .describe('A Netscape cookie file (cookies.txt)'),
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
    .default('default'),
  default: z
    .boolean()
    .optional()
    .describe('Use this jar for `cookies: true`; the first jar is the default'),
});
export type CookiesBody = z.output<typeof cookiesBody>;

interface Owner {
  clientId: string;
  userId: string;
}

const context = (owner: Owner, id: string) => `cookies:${owner.clientId}:${owner.userId}:${id}`;

const view = (jar: CookieJar) => ({
  id: jar.id,
  label: jar.label,
  domains: jar.domains,
  cookie_count: jar.cookieCount,
  is_default: jar.isDefault,
  expires_at: jar.expiresAt?.toISOString() ?? null,
  created_at: jar.createdAt.toISOString(),
});

/**
 * Per-user cookie jars (SPEC §4 /v1/cookies, §7f). Stored encrypted; the contents never leave the
 * service except as the job-local file yt-dlp reads.
 */
@Injectable()
export class CookiesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** Stores a jar, replacing the user's jar with the same label. */
  async put(auth: AuthContext, body: CookiesBody) {
    const owner = { clientId: auth.clientId, userId: requireUserId(auth) };
    const parsed = parseCookieFile(body.cookies);
    const [key] = this.config.TOKEN_ENCRYPTION_KEYS;
    if (!key) throw new Error('No encryption key configured');
    const saved = await this.db.transaction(async (tx) => {
      const jars = await tx.select().from(cookieJars).where(this.ownedBy(owner));
      const existing = jars.find((jar) => jar.label === body.label);
      if (!existing && jars.length >= COOKIE_JARS_MAX) {
        throw new AppError(
          'VALIDATION_FAILED',
          `A user can keep at most ${COOKIE_JARS_MAX} cookie jars`,
        );
      }
      const makeDefault = body.default ?? existing?.isDefault ?? !jars.some((jar) => jar.isDefault);
      if (makeDefault) {
        await tx
          .update(cookieJars)
          .set({ isDefault: false })
          .where(and(this.ownedBy(owner), eq(cookieJars.isDefault, true)));
      }
      const id = existing?.id ?? uuidv7();
      const row = {
        domains: parsed.domains,
        cookieCount: parsed.count,
        jarEnc: encryptSecret(this.config.TOKEN_ENCRYPTION_KEYS, context(owner, id), parsed.text),
        keyVersion: key.version,
        isDefault: makeDefault,
        expiresAt: parsed.expiresAt,
      };
      const [jar] = existing
        ? await tx.update(cookieJars).set(row).where(eq(cookieJars.id, id)).returning()
        : await tx
            .insert(cookieJars)
            .values({ id, ...owner, label: body.label, ...row })
            .returning();
      return jar;
    });
    if (!saved) throw new Error('The cookie jar was not saved');
    return view(saved);
  }

  async list(auth: AuthContext) {
    const owner = { clientId: auth.clientId, userId: requireUserId(auth) };
    const jars = await this.db
      .select()
      .from(cookieJars)
      .where(this.ownedBy(owner))
      .orderBy(desc(cookieJars.id));
    return { cookies: jars.map(view) };
  }

  /** Deletes one jar, or every jar of the user; a remaining jar becomes the default. */
  async remove(auth: AuthContext, id?: string) {
    const owner = { clientId: auth.clientId, userId: requireUserId(auth) };
    if (id !== undefined && !isUuid(id))
      throw new AppError('NOT_FOUND', 'There is no such cookie jar');
    return this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(cookieJars)
        .where(and(this.ownedBy(owner), id === undefined ? undefined : eq(cookieJars.id, id)))
        .returning();
      if (id !== undefined && removed.length === 0)
        throw new AppError('NOT_FOUND', 'There is no such cookie jar');
      if (removed.some((jar) => jar.isDefault)) {
        const [next] = await tx
          .select()
          .from(cookieJars)
          .where(this.ownedBy(owner))
          .orderBy(desc(cookieJars.id))
          .limit(1);
        if (next)
          await tx.update(cookieJars).set({ isDefault: true }).where(eq(cookieJars.id, next.id));
      }
      return { removed: removed.length };
    });
  }

  /** Fails early (at job creation) when the jar a job names does not exist. */
  async check(owner: Owner, ref: CookiesRef): Promise<void> {
    await this.find(owner, ref);
  }

  /** The decrypted jar, for the job-local cookie file. */
  async jarText(owner: Owner, ref: CookiesRef): Promise<string> {
    const jar = await this.find(owner, ref);
    return decryptSecret(this.config.TOKEN_ENCRYPTION_KEYS, context(owner, jar.id), jar.jarEnc);
  }

  /** Re-encrypts every jar still on an older key (key rotation, SPEC §12). */
  async reencrypt(): Promise<number> {
    const keys = this.config.TOKEN_ENCRYPTION_KEYS;
    const [current] = keys;
    if (!current) return 0;
    let count = 0;
    for (const jar of await this.db.select().from(cookieJars)) {
      if (jar.keyVersion === current.version) continue;
      const owner = { clientId: jar.clientId, userId: jar.userId };
      const text = decryptSecret(keys, context(owner, jar.id), jar.jarEnc);
      await this.db
        .update(cookieJars)
        .set({
          jarEnc: encryptSecret(keys, context(owner, jar.id), text),
          keyVersion: current.version,
        })
        .where(eq(cookieJars.id, jar.id));
      count++;
    }
    return count;
  }

  private async find(owner: Owner, ref: CookiesRef): Promise<CookieJar> {
    const [jar] = await this.db
      .select()
      .from(cookieJars)
      .where(
        and(
          this.ownedBy(owner),
          ref === true ? eq(cookieJars.isDefault, true) : eq(cookieJars.id, ref),
        ),
      );
    if (!jar) {
      throw new AppError(
        'VALIDATION_FAILED',
        ref === true
          ? 'cookies: this user has no cookie jar (PUT /v1/cookies)'
          : 'cookies: there is no such cookie jar',
      );
    }
    return jar;
  }

  private ownedBy(owner: Owner) {
    return and(eq(cookieJars.clientId, owner.clientId), eq(cookieJars.userId, owner.userId));
  }
}
