import type { JobsOptions } from 'bullmq';

export const DOWNLOAD_QUEUE = 'download';
/** Recipes (process jobs and `then` pipelines) run on worker-ff (SPEC §2). */
export const FFMPEG_QUEUE = 'ffmpeg';
/** Uploads to Google Drive after a job's outputs exist (SPEC §11); worker-dl processes it. */
export const DELIVERY_QUEUE = 'delivery';
export type QueueName = typeof DOWNLOAD_QUEUE | typeof FFMPEG_QUEUE;

export interface QueueJobData {
  jobId: string;
}

/** The queue a job row is processed on. */
export function queueForType(type: string): QueueName {
  return type === 'process' ? FFMPEG_QUEUE : DOWNLOAD_QUEUE;
}

/**
 * Up to two automatic retries with exponential backoff (SPEC §9c); the worker marks
 * non-retryable failures (private media, unsupported site, limits, recipe errors) as unrecoverable.
 */
export function queueJobOptions(jobId: string, attempt = 0): JobsOptions {
  return {
    jobId: attempt === 0 ? jobId : `${jobId}-retry${attempt}`, // BullMQ ids may not contain ':'
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  };
}
