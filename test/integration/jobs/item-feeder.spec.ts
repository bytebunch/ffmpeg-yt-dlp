import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../src/common/ids';
import { createDatabase, type Database } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import { clients, jobs } from '../../../src/db/schema';
import type { QueueJobData } from '../../../src/jobs/queues';
import { ItemCoordinator } from '../../../src/playlists/coordinator';
import { testConfig } from '../support/app';
import { poolFor, startPostgres, startRedis } from '../support/containers';

describe('item feeder (Postgres + Redis)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let redis: Redis;
  let db: Database;

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    db = createDatabase(pool);
    redis = new Redis(redisContainer.getConnectionUrl());
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
    await Promise.all([postgres.stop(), redisContainer.stop()]);
  });

  it('releases items in creation order, whatever order Postgres stores them in', async () => {
    const released: string[] = [];
    const queue = {
      add: (_name: string, data: QueueJobData) => {
        released.push(data.jobId);
        return Promise.resolve();
      },
    } as unknown as Queue<QueueJobData>;
    const config = testConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      USER_MAX_CONCURRENT_ITEMS: '2',
    });
    const coordinator = new ItemCoordinator(config, db, redis, queue, queue);

    const clientId = uuidv7();
    await db.insert(clients).values({ id: clientId, name: 'feeder' });
    const parentId = uuidv7();
    await db.insert(jobs).values({
      id: parentId,
      type: 'download',
      kind: 'parent',
      clientId,
      userId: 'u',
      status: 'running',
      stage: 'items',
    });
    // A reversed playlist: its items are created 3, 2, 1 and must be released in that order.
    const ids = { third: uuidv7(), second: uuidv7(), first: uuidv7() };
    const created: [string, number][] = [
      [ids.third, 3],
      [ids.second, 2],
      [ids.first, 1],
    ];
    await db.insert(jobs).values(
      created.map(([id, index]) => ({
        id,
        type: 'download',
        kind: 'item',
        parentJobId: parentId,
        playlistIndex: index,
        clientId,
        userId: 'u',
        status: 'queued',
        stage: 'waiting',
      })),
    );
    // Item 3 failed and was retried: changing the indexed status stores its row after the others,
    // and the feeder's UPDATE … RETURNING hands rows back in storage order.
    await db.update(jobs).set({ status: 'failed', stage: null }).where(eq(jobs.id, ids.third));
    await db.update(jobs).set({ status: 'queued', stage: 'waiting' }).where(eq(jobs.id, ids.third));

    expect(await coordinator.feed()).toBe(2);
    expect(released).toEqual([ids.third, ids.second]);
  });
});
