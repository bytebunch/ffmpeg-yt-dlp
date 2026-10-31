import type { Redis } from 'ioredis';

import type { Progress } from '../downloads/progress';

/** Recipe progress (SPEC §9c): `step` is "processing" or "stage i/n". */
export interface ProcessProgress {
  stage: 'processing';
  step: string;
  percent: number | null;
  speed: number | null;
}

/** Recording progress (SPEC §7d): waiting for a scheduled start, then recording. */
export interface LiveProgress {
  stage: 'waiting' | 'recording';
  scheduled_start: string | null;
  /** Seconds recorded so far, and the cap (max_duration_minutes). */
  recorded_s: number | null;
  limit_s: number;
  bytes: number | null;
  speed: number | null;
}

export type JobProgress = Progress | ProcessProgress | LiveProgress;

/**
 * Live job state in Redis only (SPEC §14): progress snapshots, an event channel per job, and
 * the cancel channel every worker listens to.
 */
export const CANCEL_CHANNEL = 'media:cancel';
const PROGRESS_TTL_SECONDS = 86_400;

export const progressKey = (jobId: string) => `media:progress:${jobId}`;
export const eventsChannel = (jobId: string) => `media:events:${jobId}`;

export async function writeProgress(
  redis: Redis,
  jobId: string,
  progress: JobProgress,
): Promise<void> {
  const payload = JSON.stringify(progress);
  await redis
    .multi()
    .set(progressKey(jobId), payload, 'EX', PROGRESS_TTL_SECONDS)
    .publish(eventsChannel(jobId), payload)
    .exec();
}

export async function readProgress(redis: Redis, jobId: string): Promise<JobProgress | null> {
  const value = await redis.get(progressKey(jobId));
  return value === null ? null : (JSON.parse(value) as JobProgress);
}

export async function publishStatus(redis: Redis, jobId: string, status: string): Promise<void> {
  await redis.publish(eventsChannel(jobId), JSON.stringify({ status }));
}

export async function requestCancel(redis: Redis, jobId: string): Promise<void> {
  await redis.publish(CANCEL_CHANNEL, jobId);
}

/** Idempotency-Key scoped to (client, user) for 24 hours (SPEC §4). Returns the existing job id. */
export async function claimIdempotencyKey(
  redis: Redis,
  scope: { clientId: string; userId: string; key: string },
  jobId: string,
): Promise<string | undefined> {
  const redisKey = `media:idem:${scope.clientId}:${scope.userId}:${scope.key}`;
  const claimed = await redis.set(redisKey, jobId, 'EX', 86_400, 'NX');
  if (claimed === 'OK') return undefined;
  return (await redis.get(redisKey)) ?? undefined;
}

/** Counts items against the user's daily limit; returns the new total for today. */
export async function countDailyItem(
  redis: Redis,
  clientId: string,
  userId: string,
  amount = 1,
  now = new Date(),
): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const key = `media:quota:items:${clientId}:${userId}:${day}`;
  const [[, count] = []] =
    (await redis
      .multi()
      .incrby(key, amount)
      .expire(key, 2 * 86_400)
      .exec()) ?? [];
  return Number(count);
}
