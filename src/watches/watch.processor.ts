import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { WatchRunner } from './watch-runner';

export const WATCH_QUEUE = 'watches';
const TICK_MS = 60_000;

/** One scheduler entry for every worker-dl: due watches are claimed in the database each minute. */
@Processor(WATCH_QUEUE)
export class WatchProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly runner: WatchRunner,
    @InjectQueue(WATCH_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler('watch-tick', { every: TICK_MS }, { name: 'tick' });
  }

  process(): Promise<number> {
    return this.runner.tick();
  }
}
