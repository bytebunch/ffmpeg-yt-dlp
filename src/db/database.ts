import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { AppConfig } from '../config/env.schema';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

type SslSettings = Pick<AppConfig, 'DATABASE_SSL_MODE' | 'DATABASE_SSL_CA_FILE'>;

/** Maps DATABASE_SSL_MODE to node-postgres TLS options (libpq semantics). */
export function sslOptions(config: SslSettings): false | ConnectionOptions {
  const ca = config.DATABASE_SSL_CA_FILE
    ? readFileSync(config.DATABASE_SSL_CA_FILE, 'utf8')
    : undefined;
  switch (config.DATABASE_SSL_MODE) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      // The chain must verify, but the certificate may name another host.
      return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full':
      return { ca, rejectUnauthorized: true };
  }
}

export function createPool(
  connectionString: string,
  config: SslSettings & Pick<AppConfig, 'DATABASE_POOL_MAX'>,
): Pool {
  return new Pool({
    connectionString,
    ssl: sslOptions(config),
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
