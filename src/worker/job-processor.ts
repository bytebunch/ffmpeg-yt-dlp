import { WorkerHost } from '@nestjs/bullmq';
import type { Logger, OnModuleInit } from '@nestjs/common';
import { type Job as QueueJob, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { clearSecrets } from '../access/sealed';
import { AppError, type ErrorCode } from '../common/errors';
import type { Database } from '../db/database';
import { jobs } from '../db/schema';
import { publishStatus } from '../jobs/job-state';
import type { QueueJobData } from '../jobs/queues';
import type { ItemCoordinator } from '../playlists/coordinator';
import type { CancelRegistry } from './cancel-registry';

/** Transient failures are retried with backoff (SPEC §9c); everything else fails at once. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'TIMEOUT',
  'EXTRACTION_FAILED',
  'BOT_CHECK',
  'UNAVAILABLE',
  'INTERNAL',
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * Shared queue handling for both workers: cancellation, retry or failure bookkeeping, and the
 * playlist/feeder update once a job ends.
 */
export abstract class JobProcessor extends WorkerHost implements OnModuleInit {
  protected abstract readonly logger: Logger;

  constructor(
    protected readonly db: Database,
    protected readonly redis: Redis,
    private readonly cancels: CancelRegistry,
    private readonly coordinator: ItemCoordinator,
  ) {
    super();
  }

  protected abstract concurrency(): number;

  /** Runs the job; returns for completed, skipped and cancelled jobs, throws for failures. */
  protected abstract run(jobId: string, signal: AbortSignal): Promise<void>;

  onModuleInit(): void {
    this.worker.concurrency = this.concurrency();
  }

  async process(queued: QueueJob<QueueJobData>): Promise<void> {
    const { jobId } = queued.data;
    const controller = this.cancels.register(jobId);
    try {
      await this.run(jobId, controller.signal);
    } catch (error) {
      await this.failed(queued, error);
      throw error instanceof AppError && !this.retrying(queued, error)
        ? new UnrecoverableError(error.message)
        : error;
    } finally {
      this.cancels.unregister(jobId);
      await this.afterJob(jobId);
    }
  }

  private retrying(queued: QueueJob<QueueJobData>, error: AppError | undefined): boolean {
    const code: ErrorCode = error?.code ?? 'INTERNAL';
    const lastAttempt = queued.attemptsMade + 1 >= (queued.opts.attempts ?? 1);
    return (error?.retryable ?? isRetryable(code)) && !lastAttempt;
  }

  private async failed(queued: QueueJob<QueueJobData>, error: unknown): Promise<void> {
    const { jobId } = queued.data;
    const appError = error instanceof AppError ? error : undefined;
    if (!appError) this.logger.error({ err: error, jobId }, 'Job failed unexpectedly');
    const code: ErrorCode = appError?.code ?? 'INTERNAL';
    const message = appError?.message ?? 'Internal error';
    if (!this.retrying(queued, appError)) {
      await this.db
        .update(jobs)
        .set({
          status: 'failed',
          stage: null,
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
      await publishStatus(this.redis, jobId, 'failed');
      return;
    }
    await this.db
      .update(jobs)
      .set({
        status: 'queued',
        stage: 'retrying',
        errorCode: code,
        errorMessage: message,
        attempts: queued.attemptsMade + 1,
      })
      .where(eq(jobs.id, jobId));
  }

  /** A finished item updates its parent; any finished job frees a slot for waiting items. */
  private async afterJob(jobId: string): Promise<void> {
    try {
      const [job] = await this.db
        .select({ kind: jobs.kind, parentJobId: jobs.parentJobId, status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, jobId));
      if (!job || !['completed', 'failed', 'cancelled', 'skipped'].includes(job.status)) return;
      await clearSecrets(this.db, [jobId]);
      if (job.kind === 'item' && job.parentJobId)
        await this.coordinator.itemFinished(job.parentJobId);
      else await this.coordinator.feed();
    } catch (error) {
      this.logger.error({ err: error, jobId }, 'Could not update the playlist after a job');
    }
  }
}
