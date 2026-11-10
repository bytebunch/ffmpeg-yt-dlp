import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lte } from 'drizzle-orm';

import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { inputs, jobLogs, jobs, mediaFiles, outputs, uploads } from '../db/schema';
import { StoredFiles } from './stored-files';

const BATCH = 1000;

export interface CleanupReport {
  outputs: number;
  files: number;
  mediaFiles: number;
  workDirs: number;
  logs: number;
  uploads: number;
  inputs: number;
}

/**
 * Hourly cleanup (SPEC §10): expired outputs and their files, expired dedup entries, expired
 * uploads and cached inputs, orphaned work directories and old job logs. A file is deleted only
 * when no unexpired output still points at it, because dedup hits and reuse share files between
 * outputs.
 */
@Injectable()
export class Cleanup {
  private readonly logger = new Logger(Cleanup.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly files: StoredFiles,
  ) {}

  async run(now: Date = new Date()): Promise<CleanupReport> {
    const report: CleanupReport = {
      outputs: 0,
      files: 0,
      mediaFiles: 0,
      workDirs: 0,
      logs: 0,
      uploads: 0,
      inputs: 0,
    };
    for (;;) {
      const expired = await this.db
        .select({ id: outputs.id, path: outputs.path })
        .from(outputs)
        .where(lte(outputs.expiresAt, now))
        .limit(BATCH);
      if (expired.length === 0) break;
      await this.db.delete(outputs).where(
        inArray(
          outputs.id,
          expired.map((output) => output.id),
        ),
      );
      report.outputs += expired.length;
      report.files += (await this.files.release(expired.map((output) => output.path))).length;
      if (expired.length < BATCH) break;
    }
    report.mediaFiles = (
      await this.db
        .delete(mediaFiles)
        .where(lte(mediaFiles.expiresAt, now))
        .returning({ id: mediaFiles.id })
    ).length;
    // Neither a cache hit nor using an upload extends its expiry, so a job may still be reading
    // one it resolved just before: they go once they have been expired longer than a job can run.
    const unused = this.unusedSince(now);
    report.uploads = await this.removeExpiredUploads(unused);
    report.inputs = await this.removeExpiredInputs(unused);
    report.workDirs = await this.removeOrphanedWorkDirs(now);
    const logCutoff = new Date(now.getTime() - this.config.FILE_TTL_DAYS * 86_400_000);
    const oldJobs = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(lte(jobs.finishedAt, logCutoff));
    report.logs = (
      await this.db
        .delete(jobLogs)
        .where(inArray(jobLogs.jobId, oldJobs))
        .returning({ jobId: jobLogs.jobId })
    ).length;
    if (Object.values(report).some((count) => count > 0))
      this.logger.log(report, 'Cleanup finished');
    return report;
  }

  /** The moment before which no running job can have started: the job timeout plus an hour. */
  private unusedSince(now: Date): Date {
    return new Date(now.getTime() - (this.config.JOB_TIMEOUT_MINUTES + 60) * 60_000);
  }

  /** Expired uploads (SPEC §4: unused uploads after UPLOAD_TTL_HOURS): the file and tus metadata. */
  private async removeExpiredUploads(before: Date): Promise<number> {
    const expired = await this.db
      .delete(uploads)
      .where(lte(uploads.expiresAt, before))
      .returning({ path: uploads.path });
    for (const upload of expired) {
      await this.files.remove(upload.path, { pruneParents: false });
      await this.files.remove(`${upload.path}.json`, { pruneParents: false });
    }
    return expired.length;
  }

  /** Cached URL inputs past INPUT_CACHE_HOURS; a file goes once no cache entry points at it. */
  private async removeExpiredInputs(before: Date): Promise<number> {
    const expired = await this.db
      .delete(inputs)
      .where(lte(inputs.expiresAt, before))
      .returning({ path: inputs.path });
    const paths = [...new Set(expired.map((input) => input.path))];
    if (paths.length === 0) return 0;
    const stillUsed = new Set(
      (
        await this.db.select({ path: inputs.path }).from(inputs).where(inArray(inputs.path, paths))
      ).map((row) => row.path),
    );
    for (const relative of paths.filter((candidate) => !stillUsed.has(candidate)))
      await this.files.remove(relative, { pruneParents: false });
    return expired.length;
  }

  /** Work directories outlive their job only if a worker died; removed after the job timeout. */
  private async removeOrphanedWorkDirs(now: Date): Promise<number> {
    const workRoot = path.join(this.config.FILES_DIR, '.work');
    let names: string[];
    try {
      names = await readdir(workRoot);
    } catch {
      return 0;
    }
    const cutoff = this.unusedSince(now).getTime();
    const old: string[] = [];
    for (const name of names) {
      const { mtimeMs } = await stat(path.join(workRoot, name)).catch(() => ({
        mtimeMs: now.getTime(),
      }));
      if (mtimeMs < cutoff) old.push(name);
    }
    if (old.length === 0) return 0;
    const active = new Set(
      (
        await this.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              inArray(
                jobs.id,
                old.filter((name) => /^[0-9a-f-]{36}$/.test(name)),
              ),
              eq(jobs.status, 'running'),
            ),
          )
      ).map((row) => row.id),
    );
    let removed = 0;
    for (const name of old.filter((candidate) => !active.has(candidate))) {
      await rm(path.join(workRoot, name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
}
