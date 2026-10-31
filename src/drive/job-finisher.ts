import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { REDIS } from '../common/tokens';
import type { Job, jobs } from '../db/schema';
import { publishStatus } from '../jobs/job-state';
import { DELIVERY_QUEUE, type QueueJobData, queueJobOptions } from '../jobs/queues';
import { driveDestination, type FinalStatus } from './destination';

/**
 * Ends jobs: with signed links a job finishes at once; with a Drive destination it stays
 * `running` in stage `uploading` until the delivery worker has put its outputs in Drive.
 */
@Injectable()
export class JobFinisher {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(DELIVERY_QUEUE) private readonly delivery: Queue<QueueJobData>,
  ) {}

  /** The row values that end a job (written in the same transaction as its outputs). */
  end(
    job: Pick<Job, 'destination'>,
    status: FinalStatus = 'completed',
  ): Partial<typeof jobs.$inferInsert> {
    const destination = driveDestination(job.destination);
    if (!destination) return { status, stage: null, finishedAt: new Date() };
    return {
      status: 'running',
      stage: 'uploading',
      destination: { ...destination, _status: status },
    };
  }

  /** After the commit: announce the status, or queue the upload. */
  async announce(
    job: Pick<Job, 'id' | 'destination' | 'attempts'>,
    status: FinalStatus = 'completed',
  ): Promise<void> {
    if (driveDestination(job.destination)) {
      await this.delivery.add(
        DELIVERY_QUEUE,
        { jobId: job.id },
        queueJobOptions(`${job.id}-drive`, job.attempts),
      );
      return;
    }
    await publishStatus(this.redis, job.id, status);
  }
}
