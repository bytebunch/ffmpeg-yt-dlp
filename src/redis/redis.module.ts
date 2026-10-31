import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { APP_CONFIG, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';

const FIRST_CONNECT_WAIT_MS = 5_000;
const ERROR_LOG_INTERVAL_MS = 30_000;

/** Resolves on the first `ready` or `error`, or after the timeout: startup never hangs on Redis. */
export function waitForFirstConnection(redis: Redis, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(timer);
      redis.off('ready', settle);
      redis.off('error', settle);
      resolve();
    };
    const timer = setTimeout(settle, timeoutMs);
    redis.once('ready', settle);
    redis.once('error', settle);
  });
}

export async function createRedis(url: string): Promise<Redis> {
  const logger = new Logger('Redis');
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
  let lastLogged = 0;
  redis.on('error', (error: Error) => {
    const now = Date.now();
    if (now - lastLogged < ERROR_LOG_INTERVAL_MS) return;
    lastLogged = now;
    logger.error({ err: error }, 'Redis connection error (reconnecting)');
  });
  await waitForFirstConnection(redis, FIRST_CONNECT_WAIT_MS);
  return redis;
}

/**
 * The request-path Redis connection (rate limits, locks, progress reads). Commands fail fast
 * while disconnected instead of queueing, so a Redis outage never stalls HTTP requests.
 * BullMQ gets its own connections (it needs maxRetriesPerRequest: null).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRedis(config.REDIS_URL),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => {
      this.redis.disconnect();
    });
  }
}
