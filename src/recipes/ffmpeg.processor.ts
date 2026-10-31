import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { FFMPEG_QUEUE } from '../jobs/queues';
import { ItemCoordinator } from '../playlists/coordinator';
import { CancelRegistry } from '../worker/cancel-registry';
import { JobProcessor } from '../worker/job-processor';
import { ProcessExecutor } from './process.executor';

/** worker-ff: recipes, FFMPEG_CONCURRENCY at a time. */
@Processor(FFMPEG_QUEUE)
export class FfmpegProcessor extends JobProcessor {
  protected readonly logger = new Logger(FfmpegProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) db: Database,
    @Inject(REDIS) redis: Redis,
    cancels: CancelRegistry,
    coordinator: ItemCoordinator,
    private readonly executor: ProcessExecutor,
  ) {
    super(db, redis, cancels, coordinator);
  }

  protected concurrency(): number {
    return this.config.FFMPEG_CONCURRENCY;
  }

  protected run(jobId: string, signal: AbortSignal): Promise<void> {
    return this.executor.execute(jobId, signal);
  }
}
