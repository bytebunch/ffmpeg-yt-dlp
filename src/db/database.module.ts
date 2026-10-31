import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';

import { APP_CONFIG, DATABASE, PG_POOL } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import { createDatabase, createPool } from './database';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPool(config.DATABASE_URL, config),
    },
    { provide: DATABASE, inject: [PG_POOL], useFactory: createDatabase },
  ],
  exports: [PG_POOL, DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
