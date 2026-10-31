import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS } from '../common/tokens';
import { CANCEL_CHANNEL } from '../jobs/job-state';

/**
 * Cross-container cancel (SPEC §9c): the API publishes a job id on the cancel channel; the
 * worker running that job aborts it, which kills the yt-dlp process.
 */
@Injectable()
export class CancelRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CancelRegistry.name);
  private readonly running = new Map<string, AbortController>();
  private subscriber: Redis | undefined;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate({
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    this.subscriber.on('message', (_channel: string, jobId: string) => {
      this.running.get(jobId)?.abort();
    });
    this.subscriber.on('error', (error: Error) => {
      this.logger.warn({ err: error }, 'Cancel channel connection error');
    });
    await this.subscriber.subscribe(CANCEL_CHANNEL);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => {
      this.subscriber?.disconnect();
    });
  }

  register(jobId: string): AbortController {
    const controller = new AbortController();
    this.running.set(jobId, controller);
    return controller;
  }

  unregister(jobId: string): void {
    this.running.delete(jobId);
  }
}
