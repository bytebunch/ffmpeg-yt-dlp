import { rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';

import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { outputs } from '../db/schema';

/** Paths per `IN (...)` query, as in the hourly cleanup. */
const BATCH = 1000;

/**
 * The files under FILES_DIR that outputs point at. Dedup hits and reuse as an input give several
 * outputs the same path, so a file goes only once no output row needs it. Used by the hourly
 * cleanup (expired outputs) and by deletes on request (SPEC §10).
 */
@Injectable()
export class StoredFiles {
  private readonly logger = new Logger(StoredFiles.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /**
   * Deletes those of `paths` that no output row points at any more, and returns them. Call it
   * after the rows are gone.
   */
  async release(paths: readonly string[]): Promise<string[]> {
    const unique = [...new Set(paths)];
    const removed: string[] = [];
    for (let start = 0; start < unique.length; start += BATCH) {
      const batch = unique.slice(start, start + BATCH);
      const stillUsed = new Set(
        (
          await this.db
            .select({ path: outputs.path })
            .from(outputs)
            .where(inArray(outputs.path, batch))
        ).map((row) => row.path),
      );
      for (const relative of batch.filter((candidate) => !stillUsed.has(candidate))) {
        if (await this.remove(relative)) removed.push(relative);
      }
    }
    return removed;
  }

  /**
   * Deletes FILES_DIR/<relative> and, unless `pruneParents` is false, the now-empty <outputId> and
   * <jobId> directories above it. Flat stores (.uploads, .inputs) keep their directory.
   */
  async remove(relative: string, { pruneParents = true } = {}): Promise<boolean> {
    const root = path.resolve(this.config.FILES_DIR);
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) {
      this.logger.error({ relative }, 'Refusing to delete a path outside FILES_DIR');
      return false;
    }
    await rm(target, { recursive: true, force: true });
    if (!pruneParents) return true;
    for (
      let dir = path.dirname(target);
      dir !== root && dir.startsWith(root);
      dir = path.dirname(dir)
    ) {
      try {
        await rmdir(dir);
      } catch {
        break; // Not empty: other outputs of the job remain.
      }
    }
    return true;
  }
}
