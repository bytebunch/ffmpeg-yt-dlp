import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { base32Decode, decryptSecret, encryptSecret, totp } from '../common/secrets';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type SiteCredential, siteCredentials } from '../db/schema';
import { hasControlCharacters } from '../recipes/values';
import { SITE_KEY } from './options';

const isSeed = (value: string) => {
  try {
    return base32Decode(value).length >= 10;
  } catch {
    return false;
  }
};

export const credentialBody = z.strictObject({
  username: z
    .string()
    .min(1)
    .max(320)
    .refine(
      (value) => !hasControlCharacters(value) && !value.includes('\n'),
      'must not contain control characters',
    ),
  password: z.string().min(1).max(1024),
  totp_seed: z
    .string()
    .max(256)
    .refine(isSeed, 'must be a base32 TOTP seed of at least 80 bits')
    .optional(),
});
export type CredentialBody = z.output<typeof credentialBody>;

interface Owner {
  clientId: string;
  userId: string;
}

export interface SiteLogin {
  username: string;
  password: string;
  /** The current TOTP code, when a seed is stored. */
  twoFactor?: string;
}

const context = (owner: Owner, site: string, part: 'password' | 'totp') =>
  `credentials:${owner.clientId}:${owner.userId}:${site}:${part}`;

/**
 * The site login vault (SPEC §4 /v1/credentials, §7f), behind SITE_CREDENTIALS_ENABLED. Deleting
 * always works, so a user can remove stored secrets after the owner turns the feature off.
 */
@Injectable()
export class CredentialsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async put(auth: AuthContext, site: string, body: CredentialBody) {
    this.requireEnabled();
    const owner = { clientId: auth.clientId, userId: requireUserId(auth) };
    const siteKey = this.siteKey(site);
    const keys = this.config.TOKEN_ENCRYPTION_KEYS;
    const [key] = keys;
    if (!key) throw new Error('No encryption key configured');
    const row = {
      username: body.username,
      secretEnc: encryptSecret(keys, context(owner, siteKey, 'password'), body.password),
      totpSeedEnc:
        body.totp_seed === undefined
          ? null
          : encryptSecret(keys, context(owner, siteKey, 'totp'), body.totp_seed),
      keyVersion: key.version,
    };
    const [saved] = await this.db
      .insert(siteCredentials)
      .values({ ...owner, siteKey, ...row })
      .onConflictDoUpdate({
        target: [siteCredentials.clientId, siteCredentials.userId, siteCredentials.siteKey],
        set: row,
      })
      .returning();
    if (!saved) throw new Error('The credentials were not saved');
    return {
      site_key: saved.siteKey,
      username: saved.username,
      has_totp: saved.totpSeedEnc !== null,
    };
  }

  async remove(auth: AuthContext, site: string) {
    const owner = { clientId: auth.clientId, userId: requireUserId(auth) };
    const removed = await this.db
      .delete(siteCredentials)
      .where(this.where(owner, this.siteKey(site)))
      .returning();
    if (removed.length === 0)
      throw new AppError('NOT_FOUND', `There are no credentials for "${site}"`);
    return { removed: removed.length };
  }

  async check(owner: Owner, site: string): Promise<void> {
    await this.find(owner, site);
  }

  /** The login for a job, with a fresh TOTP code. */
  async login(owner: Owner, site: string, now = Date.now()): Promise<SiteLogin> {
    const found = await this.find(owner, site);
    const keys = this.config.TOKEN_ENCRYPTION_KEYS;
    const password = decryptSecret(
      keys,
      context(owner, found.siteKey, 'password'),
      found.secretEnc,
    );
    const seed =
      found.totpSeedEnc === null
        ? undefined
        : decryptSecret(keys, context(owner, found.siteKey, 'totp'), found.totpSeedEnc);
    return {
      username: found.username,
      password,
      ...(seed !== undefined && { twoFactor: totp(seed, now) }),
    };
  }

  /** Re-encrypts every login still on an older key (key rotation, SPEC §12). */
  async reencrypt(): Promise<number> {
    const keys = this.config.TOKEN_ENCRYPTION_KEYS;
    const [current] = keys;
    if (!current) return 0;
    let count = 0;
    for (const row of await this.db.select().from(siteCredentials)) {
      if (row.keyVersion === current.version) continue;
      const owner = { clientId: row.clientId, userId: row.userId };
      const reseal = (part: 'password' | 'totp', token: string) =>
        encryptSecret(
          keys,
          context(owner, row.siteKey, part),
          decryptSecret(keys, context(owner, row.siteKey, part), token),
        );
      await this.db
        .update(siteCredentials)
        .set({
          secretEnc: reseal('password', row.secretEnc),
          totpSeedEnc: row.totpSeedEnc === null ? null : reseal('totp', row.totpSeedEnc),
          keyVersion: current.version,
        })
        .where(eq(siteCredentials.id, row.id));
      count++;
    }
    return count;
  }

  private async find(owner: Owner, site: string): Promise<SiteCredential> {
    this.requireEnabled();
    const [found] = await this.db
      .select()
      .from(siteCredentials)
      .where(this.where(owner, this.siteKey(site)));
    if (!found)
      throw new AppError(
        'VALIDATION_FAILED',
        `credentials: there are no credentials for "${site}"`,
      );
    return found;
  }

  private requireEnabled(): void {
    if (!this.config.SITE_CREDENTIALS_ENABLED) {
      throw new AppError(
        'FEATURE_DISABLED',
        'Site credentials are disabled on this server (SITE_CREDENTIALS_ENABLED); use cookies',
      );
    }
  }

  private siteKey(site: string): string {
    if (!SITE_KEY.test(site))
      throw new AppError(
        'VALIDATION_FAILED',
        'The site key must be lowercase letters, digits, "_", "." or "-"',
      );
    return site;
  }

  private where(owner: Owner, siteKey: string) {
    return and(
      eq(siteCredentials.clientId, owner.clientId),
      eq(siteCredentials.userId, owner.userId),
      eq(siteCredentials.siteKey, siteKey),
    );
  }
}
