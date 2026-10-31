import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../src/auth/api-keys';
import { createDatabase } from '../../src/db/database';
import { runMigrations } from '../../src/db/migrations';
import { createTestApp, testConfig } from '../integration/support/app';
import { poolFor, startPostgres, startRedis } from '../integration/support/containers';
import { type JobStack, startJobStack } from '../integration/support/jobs';

/**
 * The whole app with the real yt-dlp, the real DNS resolver and real YouTube. Uses "Me at the
 * zoo" (jNQXAC9IVRw), YouTube's first video, which is stable and has chapters and captions.
 */
describe('live: YouTube through the API', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: NestFastifyApplication;
  let auth: Record<string, string>;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const { key } = await new ApiKeyService(createDatabase(pool)).create({ clientName: 'live' });
    auth = { authorization: `Bearer ${key}` };
    app = await createTestApp(
      testConfig({
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        YTDLP_BIN: 'yt-dlp',
        DENO_BIN: '/usr/local/bin/deno',
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: auth, payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

  it('reads video metadata with formats, chapters and captions, without stream URLs', async () => {
    const response = await post('/v1/info', {
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      include: ['formats', 'chapters', 'subtitles'],
      preset: '360p',
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      title: string;
      formats: unknown[];
      chapters: unknown[];
      requested_formats: unknown[];
    }>();
    expect(body.title).toBe('Me at the zoo');
    expect(body.formats.length).toBeGreaterThan(5);
    expect(body.chapters).toHaveLength(3);
    expect(body.requested_formats.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('googlevideo');
  });

  it('pages a playlist', async () => {
    const response = await post('/v1/info', {
      url: 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
      limit: 3,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ type: string; entries: unknown[]; next_cursor: string | null }>();
    expect(body.type).toBe('playlist');
    expect(body.entries).toHaveLength(3);
    expect(body.next_cursor).not.toBeNull();
  });

  it('searches by relevance and by upload date', async () => {
    for (const sort of ['relevance', 'date']) {
      const response = await get(`/v1/search?q=me%20at%20the%20zoo&limit=3&sort=${sort}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ results: unknown[] }>().results).toHaveLength(3);
    }
  });

  it('returns the English transcript', async () => {
    const response = await post('/v1/transcripts', {
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      format: 'txt',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ content: string }>().content).toContain('elephants');
  });

  it('returns top comments', async () => {
    const response = await post('/v1/comments', {
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      max: 5,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ comments: unknown[] }>().comments).toHaveLength(5);
  });
});

describe('live: a real YouTube playlist through API and worker', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const { key } = await new ApiKeyService(createDatabase(pool)).create({
      clientName: 'live-playlist',
    });
    const auth = { authorization: `Bearer ${key}`, 'x-user-id': 'live' };
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        YTDLP_BIN: 'yt-dlp',
        DENO_BIN: '/usr/local/bin/deno',
        DISK_QUOTA_PERCENT: '99',
      },
      auth,
      { realDns: true },
    );
  });

  afterAll(async () => {
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('expands items 2-3 of a playlist and downloads both at 360p', async () => {
    const created = await stack.create({
      type: 'download',
      url: 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
      items: '2-3',
      preset: '360p',
    });
    expect(created.statusCode, created.body).toBe(202);
    const job = await stack.waitFor(created.json<{ id: string }>().id, undefined, 170_000);
    expect(job, JSON.stringify(job)).toMatchObject({
      kind: 'parent',
      status: 'completed',
      items: { total: 2, completed: 2 },
    });
    const listed = (await stack.get(`/v1/jobs/${job.id}/items`)).json<{
      items: { index: number }[];
    }>();
    expect(listed.items.map((item) => item.index)).toEqual([2, 3]);
    const { outputs } = (await stack.get(`/v1/jobs/${job.id}/outputs`)).json<{
      outputs: { role: string; probe: { streams: { height: number | null }[] } }[];
    }>();
    const media = outputs.filter((output) => output.role === 'media');
    expect(media).toHaveLength(2);
    for (const output of media) {
      expect(
        Math.max(...output.probe.streams.map((stream) => stream.height ?? 0)),
      ).toBeLessThanOrEqual(360);
    }
  });

  // The daily canary's recipe check (SPEC §16): a real download handed to worker-ff.
  it('downloads a video and runs a then recipe on it', async () => {
    const created = await stack.create({
      type: 'download',
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      preset: '360p',
      then: {
        steps: [
          { op: 'trim', start: 0, end: 5 },
          { op: 'encode', name: 'clip', container: 'mp4' },
          { op: 'loudness' },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const job = await stack.waitFor(created.json<{ id: string }>().id, undefined, 170_000);
    expect(job, JSON.stringify(job)).toMatchObject({ status: 'completed' });
    // Recipe outputs are named <input stem>.<output name>.<ext>.
    const clip = job.outputs.find((output) => output.name.endsWith('.clip.mp4'));
    expect(clip?.duration_s).toBeGreaterThan(4);
    expect(clip?.duration_s).toBeLessThan(6);
    expect(job.outputs.some((output) => output.role === 'report')).toBe(true);
  });
});
