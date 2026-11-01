import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

// Any constant works; it only has to be the same for every process that migrates.
const MIGRATION_LOCK_ID = 727_271_001;

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

/**
 * One line naming why migrations failed. install.sh shows the last line `migrate` prints when it
 * checks an outside database, so a stack trace would hide the cause.
 */
export function describeMigrationFailure(error: unknown): string {
  return `Migrations failed: ${failureReason(error)}`;
}

function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Node reports a refused connection to every address of a host as an AggregateError with no message.
  if (!error.message && error instanceof AggregateError && error.errors.length > 0) {
    return failureReason(error.errors[0]);
  }
  const firstLine = error.message.split('\n', 1)[0] ?? '';
  const code = (error as { code?: unknown }).code;
  // Postgres SQLSTATE codes (28P01: wrong password, 3D000: no such database) say more than the text.
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? `${firstLine} (${code})`
    : firstLine;
}

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
