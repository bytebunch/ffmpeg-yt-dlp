import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import { YtDlpRunner } from '../ytdlp/runner';
import { runnerSettings } from '../ytdlp/runner-settings';
import { systemResolver } from '../ytdlp/url-guard';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService, URL_RESOLVER } from './discovery.service';

@Module({
  // The user's jar and site login for lookups made as them (SPEC §7f).
  imports: [AccessModule],
  controllers: [DiscoveryController],
  providers: [
    {
      provide: YtDlpRunner,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new YtDlpRunner(runnerSettings(config)),
    },
    { provide: URL_RESOLVER, useValue: systemResolver },
    DiscoveryService,
  ],
  exports: [YtDlpRunner, URL_RESOLVER, DiscoveryService],
})
export class DiscoveryModule {}
