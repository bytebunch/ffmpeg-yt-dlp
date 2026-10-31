import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { DATABASE } from '../common/tokens';
import type { Database } from '../db/database';
import { archive } from '../db/schema';

const extractor = z.string().regex(/^[A-Za-z0-9_:.-]{1,64}$/, 'extractor names only');
const mediaId = z.string().regex(/^[^\s/]{1,256}$/, 'must be a media id without spaces');

export const archiveEntry = z.strictObject({ extractor, media_id: mediaId });
export const archivePage = z.strictObject({
  cursor: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** The user's download archive (SPEC §4 per-user settings; used by skip_downloaded). */
@Injectable()
export class ArchiveService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(auth: AuthContext, query: z.output<typeof archivePage>) {
    const userId = requireUserId(auth);
    const offset =
      query.cursor === undefined ? 0 : Number(Buffer.from(query.cursor, 'base64url').toString());
    if (!Number.isInteger(offset) || offset < 0)
      throw new AppError('VALIDATION_FAILED', 'The cursor is not valid');
    const rows = await this.db
      .select()
      .from(archive)
      .where(and(eq(archive.clientId, auth.clientId), eq(archive.userId, userId)))
      .orderBy(desc(archive.createdAt), desc(archive.mediaId))
      .limit(query.limit + 1)
      .offset(offset);
    return {
      entries: rows.slice(0, query.limit).map((row) => ({
        extractor: row.extractor,
        media_id: row.mediaId,
        job_id: row.jobId,
        created_at: row.createdAt.toISOString(),
      })),
      next_cursor:
        rows.length > query.limit
          ? Buffer.from(String(offset + query.limit)).toString('base64url')
          : null,
    };
  }

  async import(auth: AuthContext, body: { entries: z.output<typeof archiveEntry>[] }) {
    const userId = requireUserId(auth);
    const inserted = await this.db
      .insert(archive)
      .values(
        body.entries.map((entry) => ({
          clientId: auth.clientId,
          userId,
          extractor: entry.extractor,
          mediaId: entry.media_id,
        })),
      )
      .onConflictDoNothing()
      .returning({ mediaId: archive.mediaId });
    return { imported: inserted.length };
  }

  /** `entry` is "<extractor>:<media_id>", e.g. youtube:dQw4w9WgXcQ. */
  async remove(auth: AuthContext, entry: string) {
    const userId = requireUserId(auth);
    const separator = entry.indexOf(':');
    const parsed = z
      .object({ extractor, media_id: mediaId })
      .safeParse({ extractor: entry.slice(0, separator), media_id: entry.slice(separator + 1) });
    if (separator < 1 || !parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Use <extractor>:<media_id>, e.g. youtube:dQw4w9WgXcQ',
      );
    }
    const removed = await this.db
      .delete(archive)
      .where(
        and(
          eq(archive.clientId, auth.clientId),
          eq(archive.userId, userId),
          eq(archive.extractor, parsed.data.extractor),
          eq(archive.mediaId, parsed.data.media_id),
        ),
      )
      .returning({ mediaId: archive.mediaId });
    if (removed.length === 0) throw new AppError('NOT_FOUND', 'No such archive entry');
    return { removed: removed.length };
  }
}
