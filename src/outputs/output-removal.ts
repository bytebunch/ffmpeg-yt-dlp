import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, ne, or } from 'drizzle-orm';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { isUuid } from '../common/ids';
import { DATABASE } from '../common/tokens';
import type { Database } from '../db/database';
import { type Job, jobs, mediaFiles, type Output, outputs } from '../db/schema';
import { JobsService, TERMINAL_STATUSES } from '../jobs/jobs.service';
import { StoredFiles } from '../maintenance/stored-files';

/** Rows per `IN (...)`: a big playlist has thousands of outputs, Postgres takes 65,535 parameters. */
const BATCH = 1000;

/** What a delete did. */
export interface Removal {
  /** Files the user could see that are gone (hidden originals a recipe replaced aren't counted). */
  deleted: number;
  /** Bytes taken off the disk. A file another job still uses stays, and doesn't count. */
  freed_bytes: number;
}

const batches = <T>(items: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / BATCH) }, (_, index) =>
    items.slice(index * BATCH, (index + 1) * BATCH),
  );

/**
 * Deletes a user's finished files before they expire (SPEC §10). The Drive copy and the download
 * archive entry stay: the first is the user's own, the second keeps watches from fetching the
 * item again.
 */
@Injectable()
export class OutputRemoval {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly files: StoredFiles,
  ) {}

  /** `DELETE /v1/outputs/:id`: one of the user's own files. */
  async deleteOutput(auth: AuthContext, id: string): Promise<Removal> {
    const userId = requireUserId(auth);
    const notFound = new AppError('NOT_FOUND', 'File not found');
    if (!isUuid(id)) throw notFound;
    const now = new Date();
    const [found] = await this.db
      .select({ output: outputs, job: jobs })
      .from(outputs)
      .innerJoin(jobs, eq(jobs.id, outputs.jobId))
      .where(
        and(
          eq(outputs.id, id),
          eq(outputs.clientId, auth.clientId),
          eq(outputs.userId, userId),
          eq(outputs.hidden, false),
          gt(outputs.expiresAt, now),
        ),
      );
    if (!found) throw notFound;
    await this.assertFinished(found.job);
    // A job's hidden originals only back the files it shows, so they go with the last of them.
    const rest = await this.db
      .select()
      .from(outputs)
      .where(and(eq(outputs.jobId, found.job.id), ne(outputs.id, id)));
    const othersShown = rest.some((row) => !row.hidden && row.expiresAt > now);
    return this.remove([found.output, ...(othersShown ? [] : rest.filter((row) => row.hidden))]);
  }

  /** `DELETE /v1/jobs/:id/outputs`: every file of a job; of a playlist or batch, every item's. */
  async deleteJobOutputs(auth: AuthContext, jobId: string): Promise<Removal> {
    const job = await this.jobs.find(auth, jobId);
    await this.assertFinished(job);
    const items = this.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.parentJobId, job.id));
    const rows = await this.db
      .select()
      .from(outputs)
      .where(
        job.kind === 'parent'
          ? or(eq(outputs.jobId, job.id), inArray(outputs.jobId, items))
          : eq(outputs.jobId, job.id),
      );
    return this.remove(rows);
  }

  /**
   * A running job may still read its files (a `then` recipe, a playlist's ZIP or concat), so the
   * job and the playlist or batch it belongs to must have ended.
   */
  private async assertFinished(job: Job): Promise<void> {
    const [parent] = job.parentJobId
      ? await this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job.parentJobId))
      : [];
    for (const status of [job.status, parent?.status]) {
      if (status !== undefined && !TERMINAL_STATUSES.includes(status)) {
        throw new AppError(
          'JOB_NOT_FINISHED',
          'The job that made this file is still running. Delete the file once the job has ended.',
        );
      }
    }
  }

  private async remove(rows: readonly Output[]): Promise<Removal> {
    if (rows.length === 0) return { deleted: 0, freed_bytes: 0 };
    const now = new Date();
    const jobIds = new Set(rows.map((row) => row.jobId));
    const entryIds = [
      ...new Set(rows.flatMap((row) => (row.mediaFileId ? [row.mediaFileId] : []))),
    ];
    await this.db.transaction(async (tx) => {
      // A dedup entry hands its job's files to the next identical download (SPEC §9d). With some
      // of them gone it would hand over a job without its media, so the next one downloads anew.
      // Entries pointing at another job (the user's copy was a dedup hit) still work and stay.
      const stale: string[] = [];
      for (const ids of batches(entryIds)) {
        const entries = await tx
          .select({ id: mediaFiles.id, jobId: mediaFiles.jobId })
          .from(mediaFiles)
          .where(inArray(mediaFiles.id, ids));
        for (const entry of entries) {
          if (entry.jobId !== null && jobIds.has(entry.jobId)) stale.push(entry.id);
        }
      }
      for (const ids of batches(stale)) {
        await tx.delete(mediaFiles).where(inArray(mediaFiles.id, ids));
      }
      for (const batch of batches(rows)) {
        await tx.delete(outputs).where(
          inArray(
            outputs.id,
            batch.map((row) => row.id),
          ),
        );
      }
    });
    const removed = await this.files.release(rows.map((row) => row.path));
    const sizes = new Map(rows.map((row) => [row.path, row.sizeBytes ?? 0]));
    return {
      deleted: rows.filter((row) => !row.hidden && row.expiresAt > now).length,
      freed_bytes: removed.reduce((total, relative) => total + (sizes.get(relative) ?? 0), 0),
    };
  }
}
