import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { DATABASE, REDIS } from '../common/tokens';
import type { Database } from '../db/database';
import { DELIVERY_QUEUE } from '../jobs/queues';
import { ItemCoordinator } from '../playlists/coordinator';
import { CancelRegistry } from '../worker/cancel-registry';
import { JobProcessor } from '../worker/job-processor';
import { DriveDelivery } from './delivery';

/** Network-bound, so a few at a time per worker-dl. */
const DELIVERY_CONCURRENCY = 2;

/** worker-dl: Drive uploads (SPEC §11). Failures mark the job failed; its local files remain. */
@Processor(DELIVERY_QUEUE)
export class DeliveryProcessor extends JobProcessor {
  protected readonly logger = new Logger(DeliveryProcessor.name);

  constructor(
    @Inject(DATABASE) db: Database,
    @Inject(REDIS) redis: Redis,
    cancels: CancelRegistry,
    coordinator: ItemCoordinator,
    private readonly delivery: DriveDelivery,
  ) {
    super(db, redis, cancels, coordinator);
  }

  protected concurrency(): number {
    return DELIVERY_CONCURRENCY;
  }

  protected run(jobId: string, signal: AbortSignal): Promise<void> {
    return this.delivery.deliver(jobId, signal);
  }
}
