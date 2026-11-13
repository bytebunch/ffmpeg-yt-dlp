import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView } from '../../../src/jobs/jobs.service';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { ensureFakeMedia, type JobStack, startJobStack } from '../support/jobs';

const BASE = 'https://win.example.com/ffmpeg';

describe('behind a proxy that serves the service under a path (Postgres + Redis + workers)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  const auth: Record<string, string> = {};

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const { key } = await new ApiKeyService(createDatabase(pool)).create({ clientName: 'proxied' });
    Object.assign(auth, { authorization: `Bearer ${key}`, 'x-user-id': 'alice' });
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        PUBLIC_BASE_URL: `${BASE}/`,
      },
      auth,
    );
  });

  afterAll(async () => {
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  /** What reaches the service once the proxy has stripped the base path. */
  const behindProxy = (link: string) => {
    expect(link.startsWith(`${BASE}/`), link).toBe(true);
    const url = new URL(link);
    return stack.app.inject({
      method: 'GET',
      url: `${url.pathname.slice(new URL(BASE).pathname.length)}${url.search}`,
    });
  };

  it('puts the base path in every link of a job, and each one works behind the proxy', async () => {
    const created = await stack.create({
      type: 'download',
      url: 'https://fake.test/video',
      thumbnail: { write: true },
    });
    const job = await stack.waitFor(created.json<JobView>().id);
    expect(job.status).toBe('completed');
    expect(job.outputs.length).toBeGreaterThan(1);
    for (const output of job.outputs) {
      expect((await behindProxy(output.url)).statusCode, output.name).toBe(200);
    }
    for (const link of [job.archive_url, job.manifest_url]) {
      expect(link).not.toBeNull();
      expect((await behindProxy(link ?? '')).statusCode, link ?? '').toBe(200);
    }
    const playlist = (await behindProxy(job.manifest_url ?? '')).body;
    for (const line of playlist.split('\n').filter((entry) => entry.startsWith('http'))) {
      expect(line.startsWith(`${BASE}/d/`), line).toBe(true);
    }
  });

  it('hands out upload URLs under the base path', async () => {
    const response = await stack.app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: auth,
      payload: { filename: 'clip.mp4', size: 1000 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ tusUrl: string }>().tusUrl).toMatch(
      /^https:\/\/win\.example\.com\/ffmpeg\/u\/[0-9a-f-]{36}$/,
    );
  });
});
