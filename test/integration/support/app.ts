import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { configureApp, createAdapter } from '../../../src/app';
import { AppModule } from '../../../src/app.module';
import type { AppConfig } from '../../../src/config/env.schema';
import { loadConfig } from '../../../src/config/load-config';

export const FAKE_YTDLP = path.resolve(__dirname, '../../fixtures/bin/fake-yt-dlp');

export function testConfig(env: Record<string, string>): AppConfig {
  return loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LINK_SIGNING_SECRET: 'test-link-signing-secret-0123456789abcdef',
    TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    LOG_LEVEL: 'silent',
    YTDLP_BIN: FAKE_YTDLP,
    YTDLP_CACHE_DIR: '/tmp/ytdlp-test-cache',
    // Test hosts' disks are often fuller than the production quota (GitHub runners: ~87%), and
    // the disk guard would refuse every job. The guard's own test sets a low quota explicitly.
    DISK_QUOTA_PERCENT: '99',
    ...env,
  });
}

export interface TestAppOptions {
  /** Test-only controllers added next to the production ones. */
  controllers?: Type[];
  /** Providers replaced by fixed values (e.g. a DNS resolver stub). */
  overrides?: { token: unknown; value: unknown }[];
}

/** The production app module, optionally adjusted for a test, configured like main.ts. */
export async function createTestApp(
  config: AppConfig,
  options: TestAppOptions = {},
): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
    controllers: options.controllers ?? [],
  });
  for (const { token, value } of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const adapter = createAdapter();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter, {
    bufferLogs: true,
  });
  await configureApp(app, adapter);
  return app;
}
