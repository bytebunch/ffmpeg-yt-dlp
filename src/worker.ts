import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { ConfigError, loadConfig } from './config/load-config';
import { WorkerModule } from './worker/worker.module';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (config.WORKER_ROLE === undefined) {
    throw new ConfigError(['WORKER_ROLE: set "download" (worker-dl) or "ffmpeg" (worker-ff)']);
  }
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
