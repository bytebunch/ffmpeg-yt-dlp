import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

// Any constant works; it only has to be the same for every process that migrates.
const MIGRATION_LOCK_ID = 727_271_001;

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

/**
 * Applies pending migrations. A session-level advisory lock serialises concurrent runs
 * (two deploys, or migrate racing a restart), and the second run then finds nothing to do.
 */
export async function runMigrations(
  pool: Pool,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
