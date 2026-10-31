import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { Cleanup, type CleanupReport } from './cleanup';

export const MAINTENANCE_QUEUE = 'maintenance';
const HOUR_MS = 3_600_000;

/** One scheduler entry, so the hourly cleanup runs once per hour however many workers exist. */
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly cleanup: Cleanup,
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler('hourly-cleanup', { every: HOUR_MS }, { name: 'cleanup' });
  }

  process(): Promise<CleanupReport> {
    return this.cleanup.run();
  }
}
