import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { execa } from 'execa';

import type { AppConfig } from '../../../src/config/env.schema';
import { URL_RESOLVER } from '../../../src/discovery/discovery.service';
import type { JobView } from '../../../src/jobs/jobs.service';
import { WorkerModule } from '../../../src/worker/worker.module';
import { type Resolver, systemResolver } from '../../../src/ytdlp/url-guard';
import { createTestApp, testConfig } from './app';

export const publicResolver: Resolver = () => Promise.resolve(['93.184.215.14']);
export const CALLS_LOG = '/tmp/fake-yt-dlp-calls.log';
export const FINISHED = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'skipped'];

const ffmpeg = (...args: string[]) =>
  execa('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/**
 * The real media the fake yt-dlp copies: a tiny MP4 for every "download", and a 130-second
 * MPEG-TS (5 fps, a keyframe every second) for live recordings, long enough to split in minutes.
 */
export async function ensureFakeMedia(): Promise<void> {
  mkdirSync('/tmp/fake-media', { recursive: true });
  if (!existsSync('/tmp/fake-media/clip.mp4')) {
    await ffmpeg(
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2'],
      ...['-f', 'lavfi', '-i', 'sine=duration=2'],
      ...['-shortest', '-c:v', 'libx264', '-c:a', 'aac', '/tmp/fake-media/clip.mp4'],
    );
  }
  if (!existsSync('/tmp/fake-media/live.ts')) {
    await ffmpeg(
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=130'],
      ...['-f', 'lavfi', '-i', 'sine=duration=130'],
      ...['-shortest', '-c:v', 'libx264', '-g', '5', '-c:a', 'aac'],
      ...['-f', 'mpegts', '/tmp/fake-media/live.ts'],
    );
  }
}

export function fakeCalls(line: string): number {
  if (!existsSync(CALLS_LOG)) return 0;
  return readFileSync(CALLS_LOG, 'utf8')
    .split('\n')
    .filter((entry) => entry === line).length;
}

export interface JobStack {
  app: NestFastifyApplication;
  worker: TestingModule;
  config: AppConfig;
  filesDir: string;
  create: (
    payload: object,
    headers?: Record<string, string>,
  ) => ReturnType<NestFastifyApplication['inject']>;
  get: (url: string) => ReturnType<NestFastifyApplication['inject']>;
  waitFor: (id: string, done?: (job: JobView) => boolean, timeoutMs?: number) => Promise<JobView>;
  close: () => Promise<void>;
}

/** API + both workers on the given Postgres/Redis, with the fake yt-dlp and a public DNS stub. */
export async function startJobStack(
  env: Record<string, string>,
  auth: Record<string, string>,
  options: { realDns?: boolean } = {},
): Promise<JobStack> {
  const filesDir = env.FILES_DIR ?? mkdtempSync(path.join(tmpdir(), 'files-'));
  const config = testConfig({
    FFPROBE_BIN: 'ffprobe',
    API_RATE_LIMIT_PER_MINUTE: '100000',
    ...env,
    FILES_DIR: filesDir,
  });
  const resolver = options.realDns ? systemResolver : publicResolver;
  const app = await createTestApp(config, {
    overrides: [{ token: URL_RESOLVER, value: resolver }],
  });
  // One process runs both worker roles (worker-dl and worker-ff are separate containers in production).
  const worker = await Test.createTestingModule({
    imports: [WorkerModule.forRoot(config, ['download', 'ffmpeg'])],
  })
    .overrideProvider(URL_RESOLVER)
    .useValue(resolver)
    .compile();
  await worker.init();

  const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
  const waitFor = async (
    id: string,
    done: (job: JobView) => boolean = (job) => FINISHED.includes(job.status),
    timeoutMs = 30_000,
  ): Promise<JobView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = (await get(`/v1/jobs/${id}`)).json<JobView>();
      if (done(job)) return job;
      if (Date.now() > deadline)
        throw new Error(`job ${id} stuck in ${job.status}/${String(job.stage)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  return {
    app,
    worker,
    config,
    filesDir,
    create: (payload, headers = {}) =>
      app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...auth, ...headers }, payload }),
    get,
    waitFor,
    close: async () => {
      await worker.close();
      await app.close();
    },
  };
}
