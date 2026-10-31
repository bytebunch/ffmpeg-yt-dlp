import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { DATABASE } from '../common/tokens';
import type { Database } from '../db/database';
import { ApiKeyService } from './api-keys';
import { ApiKeyGuard, RateLimitGuard } from './guards';

@Module({
  providers: [
    {
      provide: ApiKeyService,
      inject: [DATABASE],
      useFactory: (db: Database) => new ApiKeyService(db),
    },
    // Guards run in registration order: authenticate first, then count against the key.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [ApiKeyService],
})
export class AuthModule {}
