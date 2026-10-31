import { rm } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { youtubeExtractorArgs } from '../access/access-args';
import { JobAccessResolver } from '../access/job-access';
import { assertDiskSpace } from '../common/disk';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { archive, jobs, type Watch, watchRuns, watchSeen, watches } from '../db/schema';
import { URL_RESOLVER } from '../discovery/discovery.service';
import { asRecord, isPlaylist } from '../discovery/mappers';
import { downloadOptionsSchema } from '../downloads/options';
import { countDailyItem } from '../jobs/job-state';
import { itemOptions, pipelineOptions } from '../jobs/schemas';
import { itemJobOptions } from '../playlists/checks';
import { ItemCoordinator } from '../playlists/coordinator';
import type { Filters } from '../playlists/filters';
import { archiveKey, type Entry, entryKey, planItems } from '../playlists/plan';
import { channelTabUrl } from '../playlists/selection';
import { YtDlpRunner } from '../ytdlp/runner';
import { guardUrl, type Resolver } from '../ytdlp/url-guard';
import { newEntries } from './select';

/** Watches claimed per tick; the rest wait for the next one. */
const CLAIM_LIMIT = 20;

interface RunResult {
  newItems: number;
  jobId: string | null;
}

/**
 * Runs due watches (SPEC §9f): expand the source flat and bounded, keep the entries the user has
 * neither downloaded nor had queued, queue them as one batch and record the run. Consecutive
 * failures pause the watch after WATCH_MAX_FAILURES.
 */
@Injectable()
export class WatchRunner {
  private readonly logger = new Logger(WatchRunner.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly runner: YtDlpRunner,
    @Inject(URL_RESOLVER) private readonly resolve: Resolver,
    private readonly access: JobAccessResolver,
    private readonly coordinator: ItemCoordinator,
  ) {}

  /** Runs every due watch once; returns how many ran. */
  async tick(now = new Date()): Promise<number> {
    // RETURNING keeps no order: the longest-waiting watch runs first.
    const due = (await this.claim(now)).sort(
      (a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime(),
    );
    for (const watch of due) await this.runOne(watch);
    return due.length;
  }

  /** Moves the next run of due watches forward in one statement, so no other worker takes them. */
  private claim(now: Date): Promise<Watch[]> {
    const dueIds = this.db
      .select({ id: watches.id })
      .from(watches)
      .where(and(eq(watches.status, 'active'), lte(watches.nextRunAt, now)))
      .orderBy(asc(watches.nextRunAt))
      .limit(CLAIM_LIMIT)
      .for('update', { skipLocked: true });
    return this.db
      .update(watches)
      .set({
        nextRunAt: sql`${now.toISOString()}::timestamptz + ${watches.intervalMinutes} * interval '1 minute'`,
        lastRunAt: now,
      })
      .where(inArray(watches.id, dueIds))
      .returning();
  }

  private async runOne(watch: Watch): Promise<void> {
    const [run] = await this.db
      .insert(watchRuns)
      .values({ watchId: watch.id })
      .returning({ id: watchRuns.id });
    if (!run) throw new Error('The watch run was not recorded');
    try {
      const result = await this.check(watch);
      await this.db
        .update(watchRuns)
        .set({ finishedAt: new Date(), newItems: result.newItems, jobId: result.jobId })
        .where(eq(watchRuns.id, run.id));
      await this.db
        .update(watches)
        .set({ failures: 0, lastError: null })
        .where(eq(watches.id, watch.id));
    } catch (error) {
      if (!(error instanceof AppError))
        this.logger.error({ err: error, watchId: watch.id }, 'Watch run failed');
      const message = error instanceof AppError ? error.message : 'Internal error';
      const failures = watch.failures + 1;
      await this.db
        .update(watchRuns)
        .set({ finishedAt: new Date(), error: message })
        .where(eq(watchRuns.id, run.id));
      await this.db
        .update(watches)
        .set({
          failures,
          lastError: message,
          ...(failures >= this.config.WATCH_MAX_FAILURES && { status: 'paused' }),
        })
        .where(eq(watches.id, watch.id));
    }
  }

  private async check(watch: Watch): Promise<RunResult> {
    const stored = watch.options;
    const owner = { clientId: watch.clientId, userId: watch.userId };
    const perItem = itemOptions(stored);
    const options = downloadOptionsSchema.parse(perItem);
    const dir = path.join(this.config.FILES_DIR, '.work', `watch-${watch.id}`);
    const access = await this.access.prepare(owner, options, stored, path.join(dir, '.access'));
    try {
      const tab =
        stored.channel_tab === 'shorts' || stored.channel_tab === 'streams'
          ? stored.channel_tab
          : 'videos';
      const url = await guardUrl(channelTabUrl(watch.url, tab), this.resolve);
      const max = this.config.WATCH_MAX_NEW_ITEMS;
      const info = asRecord(
        await this.runner.json(
          [
            '--yes-playlist',
            '--flat-playlist',
            '--playlist-end',
            String(max),
            ...youtubeExtractorArgs(options.extractor_args),
            ...access.args({ url: url.href }),
          ],
          url.href,
          {
            timeoutMs: this.config.PLAYLIST_EXPAND_TIMEOUT_SECONDS * 1000,
            ...(options.impersonate && { impersonate: options.impersonate }),
          },
        ),
      );
      if (!isPlaylist(info)) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A watch needs a channel or playlist URL, not a single video',
        );
      }
      const entries = Array.isArray(info.entries) ? (info.entries as Entry[]) : [];
      const fresh = newEntries(
        entries,
        await this.known(watch),
        stored.break_on_existing !== false,
      );
      const plan = planItems({
        entries: fresh,
        limits: {
          maxItems: max,
          maxTotalHours: this.config.PLAYLIST_MAX_TOTAL_DURATION_HOURS,
          unknownDurationMinutes: this.config.PLAYLIST_UNKNOWN_DURATION_MINUTES,
        },
        selected: false,
        maxItems: max,
        filters: stored.filters as Filters | undefined,
      });
      if (plan.items.length === 0) return { newItems: 0, jobId: null };
      await assertDiskSpace(this.config.FILES_DIR, this.config.DISK_QUOTA_PERCENT);
      const today = await countDailyItem(
        this.redis,
        watch.clientId,
        watch.userId,
        plan.items.length,
      );
      if (today > this.config.USER_MAX_ITEMS_PER_DAY) {
        throw new AppError(
          'QUOTA_EXCEEDED',
          `This user is limited to ${this.config.USER_MAX_ITEMS_PER_DAY} items per day`,
        );
      }
      const name = typeof info.title === 'string' ? info.title : watch.url;
      const jobId = await this.queueBatch(watch, name, plan.items, fresh, perItem);
      return { newItems: plan.items.length, jobId };
    } finally {
      await access.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Archive keys of everything this user downloaded, and of what this watch queued before. */
  private async known(watch: Watch): Promise<Set<string>> {
    const [downloaded, seen] = await Promise.all([
      this.db
        .select({ extractor: archive.extractor, mediaId: archive.mediaId })
        .from(archive)
        .where(and(eq(archive.clientId, watch.clientId), eq(archive.userId, watch.userId))),
      this.db
        .select({ key: watchSeen.entryKey })
        .from(watchSeen)
        .where(eq(watchSeen.watchId, watch.id)),
    ]);
    return new Set([
      ...downloaded.map((row) => archiveKey(row.extractor, row.mediaId)),
      ...seen.map((row) => row.key),
    ]);
  }

  /** One batch per run (SPEC §9f), marked with the watch that created it. */
  private async queueBatch(
    watch: Watch,
    name: string,
    items: ReturnType<typeof planItems>['items'],
    entries: Entry[],
    perItem: Record<string, unknown>,
  ): Promise<string> {
    const id = uuidv7();
    const owner = { clientId: watch.clientId, userId: watch.userId };
    const keys = new Map(entries.map((entry) => [entry.id, entryKey(entry)]));
    await this.db.transaction(async (tx) => {
      await tx.insert(jobs).values({
        id,
        type: 'batch',
        kind: 'parent',
        ...owner,
        url: watch.url,
        options: { concat_items: false, watch_id: watch.id },
        // A watch's batches share one Drive folder, named after the source (SPEC §11).
        destination:
          watch.destination === null ? null : { ...(watch.destination as object), _name: name },
        status: 'running',
        stage: 'items',
        startedAt: new Date(),
      });
      const seen = items.flatMap((item) => {
        const key = keys.get(item.id);
        return key === undefined ? [] : [{ watchId: watch.id, entryKey: key }];
      });
      if (seen.length > 0) await tx.insert(watchSeen).values(seen).onConflictDoNothing();
    });
    const options = itemJobOptions(watch.options, {
      ...perItem,
      ...pipelineOptions(watch.options),
      ...(watch.recipe !== null && { then: watch.recipe }),
    });
    await this.coordinator.createItems(
      { id, ...owner, destination: watch.destination },
      items.map((item) => ({ ...item, options })),
    );
    return id;
  }
}
