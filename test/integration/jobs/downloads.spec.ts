import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Queue } from 'bullmq';
import { execa } from 'execa';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import type { AppConfig } from '../../../src/config/env.schema';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import { URL_RESOLVER } from '../../../src/discovery/discovery.service';
import type { JobView } from '../../../src/jobs/jobs.service';
import { DOWNLOAD_QUEUE } from '../../../src/jobs/queues';
import { WorkerModule } from '../../../src/worker/worker.module';
import type { Resolver } from '../../../src/ytdlp/url-guard';
import { createTestApp, testConfig } from '../support/app';
import { auditLogAtCompletion, logLinesAtCompletion } from '../support/completion-audit';
import { poolFor, startPostgres, startRedis } from '../support/containers';

const publicResolver: Resolver = () => Promise.resolve(['93.184.215.14']);
const CALLS_LOG = '/tmp/fake-yt-dlp-calls.log';

interface ErrorBody {
  error: { code: string; message: string };
}

async function startWorker(config: AppConfig): Promise<TestingModule> {
  const worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] })
    .overrideProvider(URL_RESOLVER)
    .useValue(publicResolver)
    .compile();
  await worker.init();
  return worker;
}

describe('download jobs: API → queue → worker-dl (fake yt-dlp, Postgres + Redis)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let keys: ApiKeyService;
  let filesDir: string;
  let config: AppConfig;
  let app: NestFastifyApplication;
  let worker: TestingModule;
  let auth: Record<string, string>;

  beforeAll(async () => {
    mkdirSync('/tmp/fake-media', { recursive: true });
    await execa('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=10:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=2',
      '-shortest',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '/tmp/fake-media/clip.mp4',
    ]);
    rmSync(CALLS_LOG, { force: true });
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    await auditLogAtCompletion(pool);
    keys = new ApiKeyService(createDatabase(pool));
    const { key } = await keys.create({ clientName: 'downloads' });
    auth = { authorization: `Bearer ${key}`, 'x-user-id': 'user-1' };
    filesDir = mkdtempSync(path.join(tmpdir(), 'files-'));
    config = testConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      FILES_DIR: filesDir,
      FFPROBE_BIN: 'ffprobe',
      API_RATE_LIMIT_PER_MINUTE: '100000',
    });
    app = await createTestApp(config, {
      overrides: [{ token: URL_RESOLVER, value: publicResolver }],
    });
    worker = await startWorker(config);
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const create = (payload: object, headers: Record<string, string> = {}, target = app) =>
    target.inject({ method: 'POST', url: '/v1/jobs', headers: { ...auth, ...headers }, payload });
  const get = (url: string, headers = auth) => app.inject({ method: 'GET', url, headers });

  async function waitFor(
    id: string,
    done: (job: JobView) => boolean,
    timeoutMs = 30_000,
  ): Promise<JobView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = (await get(`/v1/jobs/${id}`)).json<JobView>();
      if (done(job)) return job;
      if (Date.now() > deadline)
        throw new Error(`job ${id} stuck in ${job.status}/${String(job.stage)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const finished = (job: JobView) => ['completed', 'failed', 'cancelled'].includes(job.status);
  const calls = (line: string) =>
    existsSync(CALLS_LOG)
      ? readFileSync(CALLS_LOG, 'utf8')
          .split('\n')
          .filter((entry) => entry === line).length
      : 0;

  describe('a successful download', () => {
    let job: JobView;

    beforeAll(async () => {
      const response = await create({
        type: 'download',
        url: 'https://fake.test/video',
        subtitles: { langs: ['en'] },
        thumbnail: { write: true },
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json<JobView>()).toMatchObject({
        status: 'queued',
        type: 'download',
        outputs: [],
      });
      job = await waitFor(response.json<JobView>().id, finished);
    });

    it('completes with media, subtitle and thumbnail outputs', () => {
      expect(job.status).toBe('completed');
      expect(job.error).toBeNull();
      expect(job.outputs.map((output) => output.role).sort()).toEqual([
        'media',
        'subtitles',
        'thumbnail',
      ]);
    });

    it('probes the media file and stores each output under <jobId>/<outputId>/', () => {
      const media = job.outputs.find((output) => output.role === 'media');
      expect(media).toMatchObject({ name: 'Me at the zoo [jNQXAC9IVRw].mp4', mime: 'video/mp4' });
      expect(media?.duration_s).toBeGreaterThan(1.5);
      expect(
        (media?.probe as { streams: { type: string }[] }).streams
          .map((stream) => stream.type)
          .sort(),
      ).toEqual(['audio', 'video']);
      for (const output of job.outputs) {
        expect(existsSync(path.join(filesDir, job.id, output.id, output.name))).toBe(true);
      }
      expect(existsSync(path.join(filesDir, '.work', job.id))).toBe(false);
    });

    it('serves outputs through signed links that nginx resolves with X-Accel-Redirect', async () => {
      const media = job.outputs.find((output) => output.role === 'media');
      const link = new URL(media?.url ?? '');
      expect(link.origin).toBe('http://localhost:3000');
      const response = await app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-accel-redirect']).toBe(
        `/_files/${job.id}/${media?.id}/Me%20at%20the%20zoo%20%5BjNQXAC9IVRw%5D.mp4`,
      );
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['content-disposition']).toContain(
        "filename*=UTF-8''Me%20at%20the%20zoo%20%5BjNQXAC9IVRw%5D.mp4",
      );
      expect(response.body).toBe('');
    });

    it('rejects tampered and expired links without revealing why', async () => {
      const media = job.outputs.find((output) => output.role === 'media');
      const link = new URL(media?.url ?? '');
      const tampered = `${link.pathname}?exp=${link.searchParams.get('exp') ?? ''}&sig=AAAA`;
      const expired = `${link.pathname}?exp=1000&sig=${link.searchParams.get('sig') ?? ''}`;
      for (const url of [tampered, expired, `/d/${media?.id ?? ''}`, '/d/not-a-uuid?exp=1&sig=x']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(404);
        expect(response.headers['x-accel-redirect']).toBeUndefined();
      }
    });

    it('stores the log before it reports completed', async () => {
      expect(await logLinesAtCompletion(pool, job.id)).toBeGreaterThan(0);
    });

    it('keeps a redacted log of the yt-dlp run', async () => {
      const { lines } = (await get(`/v1/jobs/${job.id}/log`)).json<{ lines: string[] }>();
      expect(lines.some((line) => line.includes('Downloading 1 format'))).toBe(true);
      expect(lines.join('\n')).toContain('sig=[REDACTED]');
      expect(lines.join('\n')).not.toContain('SECRETSIG');
    });

    it('streams the final state as a server-sent event', async () => {
      // light-my-request's fake socket cannot carry SSE, so this one goes over real HTTP.
      await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${await app.getUrl()}/v1/jobs/${job.id}/events`, {
        headers: auth,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(await response.text()).toContain('"status":"completed"');
    });

    it('reuses the finished files for the same request without downloading again', async () => {
      const before = calls('download jNQXAC9IVRw');
      const second = await waitFor(
        (
          await create({
            type: 'download',
            url: 'https://fake.test/video',
            subtitles: { langs: ['en'] },
            thumbnail: { write: true },
            limit_rate_kbps: 900,
          })
        ).json<JobView>().id,
        finished,
      );
      expect(second.status).toBe('completed');
      expect(calls('download jNQXAC9IVRw')).toBe(before);
      expect(second.outputs.map((output) => output.name).sort()).toEqual(
        job.outputs.map((output) => output.name).sort(),
      );
      expect(second.outputs.map((output) => output.id)).not.toEqual(
        expect.arrayContaining(job.outputs.map((output) => output.id)),
      );
    });

    it('downloads again when the options change the bytes', async () => {
      const before = calls('download jNQXAC9IVRw');
      const other = await waitFor(
        (
          await create({ type: 'download', url: 'https://fake.test/video', container: 'mkv' })
        ).json<JobView>().id,
        finished,
      );
      expect(other.status).toBe('completed');
      expect(calls('download jNQXAC9IVRw')).toBe(before + 1);
    });
  });

  it('downloads once for two concurrent identical requests (in-flight dedup)', async () => {
    const [first, second] = await Promise.all([
      create({ type: 'download', url: 'https://fake.test/mediumdl' }),
      create({ type: 'download', url: 'https://fake.test/mediumdl' }),
    ]);
    const jobs = await Promise.all(
      [first, second].map((response) => waitFor(response.json<JobView>().id, finished)),
    );
    expect(jobs.map((job) => job.status)).toEqual(['completed', 'completed']);
    expect(calls('download mediumdl')).toBe(1);
  });

  it('cancels a running download and stops yt-dlp', async () => {
    const { id } = (
      await create({ type: 'download', url: 'https://fake.test/slowdl' })
    ).json<JobView>();
    const running = await waitFor(
      id,
      (job) => job.stage === 'downloading' && job.progress !== null,
    );
    expect(running.progress?.stage).toBe('downloading');
    const cancel = await app.inject({ method: 'DELETE', url: `/v1/jobs/${id}`, headers: auth });
    expect(cancel.statusCode).toBe(202);
    const cancelled = await waitFor(id, finished, 15_000);
    expect(cancelled.status).toBe('cancelled');
    expect(existsSync(path.join(filesDir, '.work', id))).toBe(false);
  });

  it('cancels a queued job before any worker takes it', async () => {
    const queue = app.get<Queue>(getQueueToken(DOWNLOAD_QUEUE));
    await queue.pause();
    try {
      const { id } = (
        await create({ type: 'download', url: 'https://fake.test/video', filename: 'id' })
      ).json<JobView>();
      const cancelled = (
        await app.inject({ method: 'DELETE', url: `/v1/jobs/${id}`, headers: auth })
      ).json<JobView>();
      expect(cancelled.status).toBe('cancelled');
      expect(await queue.getJob(id)).toBeUndefined();
    } finally {
      await queue.resume();
    }
  });

  it('fails at once on non-retryable errors', async () => {
    const job = await waitFor(
      (await create({ type: 'download', url: 'https://fake.test/privatedl' })).json<JobView>().id,
      finished,
    );
    expect(job).toMatchObject({ status: 'failed', attempts: 0, error: { code: 'MEDIA_PRIVATE' } });
  });

  it('schedules a retry for transient errors', async () => {
    const { id } = (
      await create({ type: 'download', url: 'https://fake.test/faildl' })
    ).json<JobView>();
    const retrying = await waitFor(id, (job) => job.stage === 'retrying');
    expect(retrying).toMatchObject({
      status: 'queued',
      attempts: 1,
      error: { code: 'UNAVAILABLE' },
    });
    await app.inject({ method: 'DELETE', url: `/v1/jobs/${id}`, headers: auth });
  });

  it('fails when yt-dlp produces no media file', async () => {
    const job = await waitFor(
      (await create({ type: 'download', url: 'https://fake.test/nofile' })).json<JobView>().id,
      finished,
    );
    expect(job).toMatchObject({
      status: 'failed',
      attempts: 0,
      error: { code: 'EXTRACTION_FAILED' },
    });
  });

  it('retries a failed job on request', async () => {
    const failed = await waitFor(
      (
        await create({ type: 'download', url: 'https://fake.test/privatedl', filename: 'id' })
      ).json<JobView>().id,
      finished,
    );
    const retried = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${failed.id}/retry`,
      headers: auth,
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json<JobView>()).toMatchObject({ status: 'queued', attempts: 1, error: null });
    const again = await waitFor(failed.id, finished);
    expect(again.error?.code).toBe('MEDIA_PRIVATE');
    const completed = await waitFor(
      (
        await create({
          type: 'download',
          url: 'https://fake.test/video',
          filename: 'id',
          preset: '360p',
        })
      ).json<JobView>().id,
      finished,
    );
    expect(
      (await app.inject({ method: 'POST', url: `/v1/jobs/${completed.id}/retry`, headers: auth }))
        .statusCode,
    ).toBe(400);
  });

  describe('requests', () => {
    it('returns the same job for a repeated Idempotency-Key', async () => {
      const first = await create(
        { type: 'download', url: 'https://fake.test/video', filename: 'id' },
        { 'idempotency-key': 'order-42' },
      );
      const second = await create(
        { type: 'download', url: 'https://fake.test/video', filename: 'id' },
        { 'idempotency-key': 'order-42' },
      );
      const third = await create(
        { type: 'download', url: 'https://fake.test/video', filename: 'id' },
        { 'idempotency-key': 'order-43' },
      );
      expect(second.json<JobView>().id).toBe(first.json<JobView>().id);
      expect(third.json<JobView>().id).not.toBe(first.json<JobView>().id);
    });

    it.each([
      [
        { type: 'record', url: 'https://fake.test/video', container: 'webm' },
        400,
        'VALIDATION_FAILED',
      ],
      // cookies is `true` or a jar id (SPEC §7f).
      [
        { type: 'download', url: 'https://fake.test/video', cookies: { source: 'saved' } },
        400,
        'VALIDATION_FAILED',
      ],
      [
        { type: 'download', url: 'https://fake.test/video', then: { steps: [] } },
        400,
        'RECIPE_INVALID',
      ],
      [
        { type: 'download', url: 'https://fake.test/video', preset: 'potato' },
        400,
        'VALIDATION_FAILED',
      ],
      [
        { type: 'download', url: 'https://fake.test/video', keep_video: true },
        400,
        'VALIDATION_FAILED',
      ],
      [
        { type: 'download', url: 'https://fake.test/video', max_filesize_mb: 999_999 },
        400,
        'VALIDATION_FAILED',
      ],
      [{ type: 'download', url: 'http://10.0.0.1/video' }, 400, 'URL_NOT_ALLOWED'],
      [{ type: 'download' }, 400, 'VALIDATION_FAILED'],
    ])('refuses %j', async (payload, status, code) => {
      const response = await create(payload);
      expect(response.statusCode).toBe(status);
      expect(response.json<ErrorBody>().error.code).toBe(code);
    });

    it('needs an end-user id', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        headers: { authorization: auth.authorization ?? '' },
        payload: { type: 'download', url: 'https://fake.test/video' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.message).toMatch(/X-User-Id/);
    });

    it("hides other users' jobs", async () => {
      const { id } = (
        await create({ type: 'download', url: 'https://fake.test/video', filename: 'id' })
      ).json<JobView>();
      expect(
        (await get(`/v1/jobs/${id}`, { ...auth, 'x-user-id': 'someone-else' })).statusCode,
      ).toBe(404);
      expect((await get('/v1/jobs/not-a-uuid')).statusCode).toBe(404);
    });

    it('lists jobs newest first with cursor paging and filters', async () => {
      const first = (await get('/v1/jobs?limit=2')).json<{
        jobs: JobView[];
        next_cursor: string;
      }>();
      expect(first.jobs).toHaveLength(2);
      const second = (await get(`/v1/jobs?limit=2&cursor=${first.next_cursor}`)).json<{
        jobs: JobView[];
      }>();
      expect((second.jobs[0]?.id ?? '') < (first.jobs[1]?.id ?? '')).toBe(true);
      const failed = (await get('/v1/jobs?status=failed')).json<{ jobs: JobView[] }>();
      expect(failed.jobs.length).toBeGreaterThan(0);
      expect(failed.jobs.every((job) => job.status === 'failed')).toBe(true);
    });
  });

  describe('limits', () => {
    it('stops a download that grows beyond MAX_FILE_SIZE_MB (watchdog)', async () => {
      const small = testConfig({
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: `${redis.getConnectionUrl()}/1`,
        FILES_DIR: filesDir,
        MAX_FILE_SIZE_MB: '2',
        MAX_UPLOAD_SIZE_MB: '2',
      });
      const smallApp = await createTestApp(small, {
        overrides: [{ token: URL_RESOLVER, value: publicResolver }],
      });
      const smallWorker = await startWorker(small);
      try {
        const { id } = (
          await create({ type: 'download', url: 'https://fake.test/bigdl' }, {}, smallApp)
        ).json<JobView>();
        const deadline = Date.now() + 30_000;
        let job: JobView;
        do {
          await new Promise((resolve) => setTimeout(resolve, 300));
          job = (
            await smallApp.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: auth })
          ).json<JobView>();
        } while (!finished(job) && Date.now() < deadline);
        expect(job).toMatchObject({ status: 'failed', error: { code: 'FILE_TOO_LARGE' } });
      } finally {
        await smallWorker.close();
        await smallApp.close();
      }
    });

    it('enforces the daily item quota per user', async () => {
      const quota = await createTestApp(
        testConfig({
          DATABASE_URL: postgres.getConnectionUri(),
          REDIS_URL: `${redis.getConnectionUrl()}/2`,
          FILES_DIR: filesDir,
          USER_MAX_ITEMS_PER_DAY: '1',
        }),
        { overrides: [{ token: URL_RESOLVER, value: publicResolver }] },
      );
      try {
        const headers = { 'x-user-id': 'quota-user' };
        expect(
          (await create({ type: 'download', url: 'https://fake.test/video' }, headers, quota))
            .statusCode,
        ).toBe(202);
        const second = await create(
          { type: 'download', url: 'https://fake.test/video' },
          headers,
          quota,
        );
        expect(second.statusCode).toBe(429);
        expect(second.json<ErrorBody>().error.code).toBe('QUOTA_EXCEEDED');
      } finally {
        await quota.close();
      }
    });

    it('refuses new work when the disk is above DISK_QUOTA_PERCENT', async () => {
      const full = await createTestApp(
        testConfig({
          DATABASE_URL: postgres.getConnectionUri(),
          REDIS_URL: `${redis.getConnectionUrl()}/3`,
          FILES_DIR: filesDir,
          DISK_QUOTA_PERCENT: '1',
        }),
        { overrides: [{ token: URL_RESOLVER, value: publicResolver }] },
      );
      try {
        const response = await create(
          { type: 'download', url: 'https://fake.test/video' },
          {},
          full,
        );
        expect(response.statusCode).toBe(507);
        expect(response.json<ErrorBody>().error.code).toBe('STORAGE_FULL');
      } finally {
        await full.close();
      }
    });
  });
});
