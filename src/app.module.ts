import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { LoggerModule, type Params } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { ErrorFilter } from './common/error.filter';
import { redactUrl } from './common/redact';
import { ConfigModule } from './config/config.module';
import type { AppConfig } from './config/env.schema';
import { DatabaseModule } from './db/database.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { HealthModule } from './health/health.module';
import { AccessModule } from './access/access.module';
import { DriveModule } from './drive/drive.module';
import { InputsModule } from './inputs/inputs.module';
import { McpModule } from './mcp/mcp.module';
import { WatchesModule } from './watches/watches.module';
import { bullRoot } from './jobs/bull';
import { JobsModule } from './jobs/jobs.module';
import { MetricsModule } from './metrics/metrics.module';
import { RedisModule } from './redis/redis.module';

const QUIET_PATHS = new Set(['/health', '/metrics']);

export function loggerOptions(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      // Only id, method and a redacted URL are logged: headers carry API keys and cookies.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url ?? '') },
    },
  };
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(loggerOptions(config)),
        DatabaseModule,
        RedisModule,
        MetricsModule,
        AuthModule,
        HealthModule,
        DiscoveryModule,
        bullRoot,
        JobsModule,
        InputsModule,
        AccessModule,
        DriveModule,
        WatchesModule,
        McpModule,
      ],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
