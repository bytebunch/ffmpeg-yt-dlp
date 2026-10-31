import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { isUuid } from '../common/ids';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { outputs } from '../db/schema';
import { JobsService } from '../jobs/jobs.service';
import { InputResolver } from './resolver';
import type { Input } from './schemas';

const MB = 1024 * 1024;

export const pageSchema = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
type Page = z.output<typeof pageSchema>;

const decode = (cursor: string | undefined) =>
  cursor === undefined ? undefined : Buffer.from(cursor, 'base64url').toString('utf8');
const encode = (value: string) => Buffer.from(value).toString('base64url');

/** SPEC §4: probe any input, list the client's inbox and the user's reusable outputs. */
@Injectable()
export class InputsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly resolver: InputResolver,
    private readonly jobs: JobsService,
  ) {}

  /** Synchronous up to PROBE_MAX_MB; larger URL inputs become a `probe` job (`queued`). */
  async probe(auth: AuthContext, input: Input): Promise<{ queued: boolean; body: unknown }> {
    const owner = { ...auth, userId: requireUserId(auth) };
    try {
      const resolved = await this.resolver.resolve(input, owner, {
        maxBytes: this.config.PROBE_MAX_MB * MB,
      });
      return {
        queued: false,
        body: {
          input: { type: resolved.type, size_bytes: resolved.sizeBytes },
          probe: resolved.probe,
        },
      };
    } catch (error) {
      const remote = input.type === 'url' || input.type === 'media_url';
      if (!(error instanceof AppError && error.code === 'FILE_TOO_LARGE' && remote)) throw error;
      return {
        queued: true,
        body: { job: await this.jobs.create(auth, { type: 'probe', input }) },
      };
    }
  }

  async inbox(auth: AuthContext, query: Page) {
    const folder = path.join(this.config.INBOX_DIR, auth.clientName);
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const names = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
    const after = decode(query.cursor);
    const page = names
      .filter((name) => after === undefined || name > after)
      .slice(0, query.limit + 1);
    const files = await Promise.all(
      page.slice(0, query.limit).map(async (name) => {
        const stats = await stat(path.join(folder, name));
        return { name, size_bytes: stats.size, modified_at: stats.mtime.toISOString() };
      }),
    );
    const last = files.at(-1);
    return { files, next_cursor: page.length > query.limit && last ? encode(last.name) : null };
  }

  /** Unexpired outputs reusable as `{ type: "output", outputId }` inputs. */
  async outputs(auth: AuthContext, query: Page) {
    const userId = requireUserId(auth);
    const before = decode(query.cursor);
    if (before !== undefined && !isUuid(before))
      throw new AppError('VALIDATION_FAILED', 'The cursor is not valid');
    const rows = await this.db
      .select()
      .from(outputs)
      .where(
        and(
          eq(outputs.clientId, auth.clientId),
          auth.shareOutputsWithinClient ? undefined : eq(outputs.userId, userId),
          eq(outputs.hidden, false),
          gt(outputs.expiresAt, new Date()),
          before === undefined ? undefined : lt(outputs.id, before),
        ),
      )
      .orderBy(desc(outputs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      outputs: page.map((output) => this.jobs.outputView(output)),
      next_cursor: rows.length > query.limit && last ? encode(last.id) : null,
    };
  }
}
