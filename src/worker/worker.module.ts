import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { CookiesService } from '../access/cookies.service';
import { CredentialsService } from '../access/credentials.service';
import { JobAccessResolver } from '../access/job-access';
import { loggerOptions } from '../app.module';
import { APP_CONFIG } from '../common/tokens';
import { ConfigModule } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { DatabaseModule } from '../db/database.module';
import { URL_RESOLVER } from '../discovery/discovery.service';
import { DriveDelivery } from '../drive/delivery';
import { DeliveryProcessor } from '../drive/delivery.processor';
import { DriveConnections } from '../drive/drive-connections.service';
import { GoogleOAuth } from '../drive/google-oauth';
import { JobFinisher } from '../drive/job-finisher';
import { DownloadProcessor } from '../downloads/download.processor';
import { DownloadExecutor } from '../downloads/executor';
import { InputResolver } from '../inputs/resolver';
import { RecordExecutor } from '../live/record.executor';
import { bullRoot } from '../jobs/bull';
import { DELIVERY_QUEUE, DOWNLOAD_QUEUE, FFMPEG_QUEUE } from '../jobs/queues';
import { Cleanup } from '../maintenance/cleanup';
import { MAINTENANCE_QUEUE, MaintenanceProcessor } from '../maintenance/maintenance.processor';
import { StoredFiles } from '../maintenance/stored-files';
import { ItemCoordinator } from '../playlists/coordinator';
import { FeederTicker } from '../playlists/feeder-ticker';
import { probeWhisper, WHISPER_SETUP } from '../recipes/capabilities';
import { FfmpegProcessor } from '../recipes/ffmpeg.processor';
import { FONT_CATALOG, FontCatalog } from '../recipes/fonts';
import { ProcessExecutor } from '../recipes/process.executor';
import { RedisModule } from '../redis/redis.module';
import { WatchRunner } from '../watches/watch-runner';
import { WATCH_QUEUE, WatchProcessor } from '../watches/watch.processor';
import { YtDlpRunner } from '../ytdlp/runner';
import { runnerSettings } from '../ytdlp/runner-settings';
import { systemResolver } from '../ytdlp/url-guard';
import { CancelRegistry } from './cancel-registry';

export type WorkerRole = 'download' | 'ffmpeg';

/** worker-dl: downloads, the feeder and maintenance. */
const DOWNLOAD_PROVIDERS: Provider[] = [
  CookiesService,
  CredentialsService,
  JobAccessResolver,
  RecordExecutor,
  WatchRunner,
  WatchProcessor,
  DriveDelivery,
  DeliveryProcessor,
  DownloadExecutor,
  DownloadProcessor,
  StoredFiles,
  Cleanup,
  MaintenanceProcessor,
  FeederTicker,
];

/** worker-ff: recipes. */
const FFMPEG_PROVIDERS: Provider[] = [
  {
    provide: FONT_CATALOG,
    inject: [APP_CONFIG],
    useFactory: (appConfig: AppConfig) => FontCatalog.scan(appConfig.FONT_DIR),
  },
  { provide: WHISPER_SETUP, inject: [APP_CONFIG], useFactory: probeWhisper },
  ProcessExecutor,
  FfmpegProcessor,
];

/**
 * A worker process (no HTTP server). Production runs one role per container (WORKER_ROLE);
 * tests may run both in one process.
 */
@Module({})
export class WorkerModule {
  static forRoot(
    config: AppConfig,
    roles: readonly WorkerRole[] = [config.WORKER_ROLE ?? 'download'],
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(loggerOptions(config)),
        DatabaseModule,
        RedisModule,
        bullRoot,
        // Both roles feed playlist items to the download queue.
        BullModule.registerQueue(
          { name: DOWNLOAD_QUEUE },
          { name: FFMPEG_QUEUE },
          { name: MAINTENANCE_QUEUE },
          { name: WATCH_QUEUE },
          { name: DELIVERY_QUEUE },
        ),
      ],
      providers: [
        { provide: URL_RESOLVER, useValue: systemResolver },
        CancelRegistry,
        ItemCoordinator,
        // worker-dl downloads; worker-ff resolves media_url inputs (SPEC §5).
        {
          provide: YtDlpRunner,
          inject: [APP_CONFIG],
          useFactory: (appConfig: AppConfig) => new YtDlpRunner(runnerSettings(appConfig)),
        },
        // Both roles finish jobs, and a finished Drive job queues its upload.
        GoogleOAuth,
        DriveConnections,
        JobFinisher,
        InputResolver,
        ...(roles.includes('download') ? DOWNLOAD_PROVIDERS : []),
        ...(roles.includes('ffmpeg') ? FFMPEG_PROVIDERS : []),
      ],
    };
  }
}
