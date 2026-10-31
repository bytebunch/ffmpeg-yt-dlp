import type { IncomingMessage } from 'node:http';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { uuidv7 } from './common/ids';
import { METRICS_REGISTRY } from './common/tokens';
import type { AppConfig } from './config/env.schema';
import { type Metrics, observeHttpRequests } from './metrics/metrics';
import { UploadsService } from './uploads/uploads.service';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BODY_LIMIT_BYTES = 1024 * 1024;

/** Fastify with request ids (a well-formed X-Request-Id is kept) echoed on every response. */
export function createAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: (request: IncomingMessage) => {
      const header = request.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID.test(header) ? header : uuidv7();
    },
  });
  // Added before Nest registers its middleware, so pino-http sees the same id.
  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    (request.raw as IncomingMessage & { id?: string }).id = request.id;
    void reply.header('x-request-id', request.id);
    done();
  });
  return adapter;
}

function setupOpenApi(app: NestFastifyApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Media Service')
      .setDescription('REST API over yt-dlp and ffmpeg (SPEC.md §4). Authenticate with an API key.')
      .setVersion('v1')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(document), { jsonDocumentUrl: 'docs/json' });
}

/** Everything main.ts and the HTTP tests share once the Nest application exists. */
export async function configureApp(
  app: NestFastifyApplication,
  adapter: FastifyAdapter,
): Promise<void> {
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  observeHttpRequests(adapter.getInstance(), app.get<Metrics>(METRICS_REGISTRY));
  app.get(UploadsService).mount(adapter.getInstance());
  setupOpenApi(app);
  await app.init();
  await adapter.getInstance().ready();
}

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const adapter = createAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config), adapter, {
    bufferLogs: true,
  });
  await configureApp(app, adapter);
  return app;
}
