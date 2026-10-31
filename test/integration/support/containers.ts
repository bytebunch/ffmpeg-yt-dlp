import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';

import { createPool } from '../../../src/db/database';

export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';

export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).start();
}

export function startRedis(): Promise<StartedRedisContainer> {
  return new RedisContainer(REDIS_IMAGE).start();
}

export function poolFor(connectionUri: string, max = 5): Pool {
  return createPool(connectionUri, { DATABASE_SSL_MODE: 'disable', DATABASE_POOL_MAX: max });
}

/** Creates an empty database next to the container's default one and returns its URI. */
export async function createDatabase(
  container: StartedPostgreSqlContainer,
  name: string,
): Promise<string> {
  const admin = poolFor(container.getConnectionUri(), 1);
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const uri = new URL(container.getConnectionUri());
  uri.pathname = `/${name}`;
  return uri.toString();
}
