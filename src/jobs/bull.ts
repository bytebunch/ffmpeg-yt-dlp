import { BullModule } from '@nestjs/bullmq';
import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';

export const BULL_CONNECTION = Symbol('BULL_CONNECTION');

/**
 * The connection BullMQ shares (it duplicates it for blocking commands). BullMQ needs
 * maxRetriesPerRequest: null, and does not close a connection it was given, so this module does.
 */
@Global()
@Module({
  providers: [
    {
      provide: BULL_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const logger = new Logger('BullMQ');
        const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
        let lastLogged = 0;
        connection.on('error', (error: Error) => {
          if (Date.now() - lastLogged < 30_000) return;
          lastLogged = Date.now();
          logger.error({ err: error }, 'Queue connection error (reconnecting)');
        });
        return connection;
      },
    },
  ],
  exports: [BULL_CONNECTION],
})
export class BullConnectionModule implements OnApplicationShutdown {
  constructor(@Inject(BULL_CONNECTION) private readonly connection: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.quit().catch(() => {
      this.connection.disconnect();
    });
  }
}

export const bullRoot = BullModule.forRootAsync({
  imports: [BullConnectionModule],
  inject: [BULL_CONNECTION],
  useFactory: (connection: Redis) => ({ connection, prefix: 'media' }),
});
