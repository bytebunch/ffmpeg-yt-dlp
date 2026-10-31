import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type Job, jobs } from '../db/schema';
import { requestedDestination } from '../drive/destination';
import { publishStatus } from '../jobs/job-state';
import { DOWNLOAD_QUEUE, FFMPEG_QUEUE, queueJobOptions, type QueueJobData } from '../jobs/queues';
import type { PlannedItem } from './plan';

const FEEDER_LOCK = 'media:lock:feeder';

/** SPEC §9e: partial failures end completed_with_errors; all failed ends failed. */
export function finalStatus(counts: ItemCounts): 'failed' | 'completed_with_errors' | 'completed' {
  if (counts.failed > 0 && counts.completed + counts.skipped === 0) return 'failed';
  return counts.failed > 0 || counts.cancelled > 0 ? 'completed_with_errors' : 'completed';
}
const FEEDER_LOCK_MS = 15_000;

export interface ItemCounts {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  running: number;
  queued: number;
}

/**
 * Playlist and batch items (SPEC §9e): items wait in the database until the feeder releases them
 * to the queue, keeping at most USER_MAX_CONCURRENT_ITEMS active per user; the parent's status is
 * the aggregate of its items.
 */
@Injectable()
export class ItemCoordinator {
  private readonly logger = new Logger(ItemCoordinator.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(DOWNLOAD_QUEUE) private readonly queue: Queue<QueueJobData>,
    @InjectQueue(FFMPEG_QUEUE) private readonly ffmpeg: Queue<QueueJobData>,
  ) {}

  /** Inserts the item jobs of a parent (already marked as a parent) and starts feeding them. */
  async createItems(
    parent: Pick<Job, 'id' | 'clientId' | 'userId'> & { destination?: unknown },
    items: readonly (PlannedItem & { options: Record<string, unknown> })[],
  ): Promise<void> {
    if (items.length > 0) {
      await this.db.insert(jobs).values(
        items.map((item) => ({
          type: 'download',
          kind: 'item',
          parentJobId: parent.id,
          playlistIndex: item.index,
          clientId: parent.clientId,
          userId: parent.userId,
          url: item.url,
          options: item.options,
          // Items deliver like their parent; their outputs go into the parent's sub-folder.
          destination: requestedDestination(parent.destination),
          status: 'queued',
          stage: 'waiting',
        })),
      );
    }
    await this.db
      .update(jobs)
      .set({ kind: 'parent', totalItems: items.length, status: 'running', stage: 'items' })
      .where(eq(jobs.id, parent.id));
    if (items.length === 0) await this.finishParent(parent.id);
    else await this.feed();
  }

  /** Releases waiting items to the queue, fairly per user. Returns how many were released. */
  async feed(): Promise<number> {
    if ((await this.redis.set(FEEDER_LOCK, '1', 'PX', FEEDER_LOCK_MS, 'NX')) !== 'OK') return 0;
    let released = 0;
    try {
      const users = await this.db
        .selectDistinct({ clientId: jobs.clientId, userId: jobs.userId })
        .from(jobs)
        .where(and(eq(jobs.kind, 'item'), eq(jobs.status, 'queued'), eq(jobs.stage, 'waiting')));
      for (const user of users) released += await this.feedUser(user.clientId, user.userId);
    } finally {
      await this.redis.del(FEEDER_LOCK);
    }
    return released;
  }

  private async feedUser(clientId: string, userId: string): Promise<number> {
    const [active] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.clientId, clientId),
          eq(jobs.userId, userId),
          ne(jobs.kind, 'parent'),
          or(
            eq(jobs.status, 'running'),
            and(
              eq(jobs.status, 'queued'),
              or(isNull(jobs.stage), inArray(jobs.stage, ['fed', 'retrying'])),
            ),
          ),
        ),
      );
    const slots = this.config.USER_MAX_CONCURRENT_ITEMS - (active?.count ?? 0);
    if (slots <= 0) return 0;
    const waiting = await this.db
      .select({ id: jobs.id, attempts: jobs.attempts })
      .from(jobs)
      .where(
        and(
          eq(jobs.clientId, clientId),
          eq(jobs.userId, userId),
          eq(jobs.kind, 'item'),
          eq(jobs.stage, 'waiting'),
          eq(jobs.status, 'queued'),
        ),
      )
      .orderBy(asc(jobs.id)) // creation order: honours reverse and random
      .limit(slots);
    if (waiting.length === 0) return 0;
    const fed = await this.db
      .update(jobs)
      .set({ stage: 'fed' })
      .where(
        and(
          inArray(
            jobs.id,
            waiting.map((row) => row.id),
          ),
          eq(jobs.stage, 'waiting'),
        ),
      )
      .returning({ id: jobs.id });
    // RETURNING follows storage order (a retried item's row moves); release in creation order.
    const fedIds = new Set(fed.map((row) => row.id));
    // Attempt-numbered queue ids: BullMQ ignores an id it still remembers from a failed run.
    for (const { id, attempts } of waiting.filter((row) => fedIds.has(row.id))) {
      await this.queue.add(DOWNLOAD_QUEUE, { jobId: id }, queueJobOptions(id, attempts));
    }
    return fed.length;
  }

  async counts(parentId: string): Promise<ItemCounts> {
    const rows = await this.db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(eq(jobs.parentJobId, parentId))
      .groupBy(jobs.status);
    const by = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
    return {
      total: rows.reduce((total, row) => total + row.count, 0),
      completed: by('completed'),
      failed: by('failed'),
      cancelled: by('cancelled'),
      skipped: by('skipped'),
      running: by('running'),
      queued: by('queued'),
    };
  }

  private async wantsConcat(parentId: string): Promise<boolean> {
    const [parent] = await this.db
      .select({ options: jobs.options })
      .from(jobs)
      .where(eq(jobs.id, parentId));
    return (parent?.options as { concat_items?: boolean } | undefined)?.concat_items === true;
  }

  /** Called whenever an item ends: updates the parent's counters and, at the end, its status. */
  async itemFinished(parentId: string): Promise<void> {
    await this.finishParent(parentId);
    await this.feed();
  }

  private async finishParent(parentId: string): Promise<void> {
    const counts = await this.counts(parentId);
    const done = counts.completed + counts.failed + counts.cancelled + counts.skipped;
    await this.db
      .update(jobs)
      .set({ completedItems: counts.completed + counts.skipped, failedItems: counts.failed })
      .where(eq(jobs.id, parentId));
    if (done < counts.total) return;
    const status = finalStatus(counts);
    if (status !== 'failed' && counts.completed >= 2 && (await this.wantsConcat(parentId))) {
      // concat_items: worker-ff joins the items, then completes the parent (ProcessExecutor).
      const handed = await this.db
        .update(jobs)
        .set({ stage: 'processing' })
        .where(and(eq(jobs.id, parentId), eq(jobs.status, 'running'), eq(jobs.stage, 'items')))
        .returning({ attempts: jobs.attempts });
      if (handed[0]) {
        await this.ffmpeg.add(
          FFMPEG_QUEUE,
          { jobId: parentId },
          queueJobOptions(`${parentId}-concat`, handed[0].attempts),
        );
      }
      return;
    }
    const updated = await this.db
      .update(jobs)
      .set({ status, stage: null, finishedAt: new Date() })
      .where(and(eq(jobs.id, parentId), eq(jobs.status, 'running')))
      .returning({ id: jobs.id });
    if (updated.length > 0) {
      await publishStatus(this.redis, parentId, status);
      this.logger.log({ parentId, status, ...counts }, 'Playlist finished');
    }
  }
}
