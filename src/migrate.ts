import { ConfigError, loadConfig } from './config/load-config';
import { createPool } from './db/database';
import { runMigrations } from './db/migrations';

/** Entry point of the one-off `migrate` service: applies migrations, then exits. */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_MIGRATION_URL, { ...config, DATABASE_POOL_MAX: 1 });
  try {
    await runMigrations(pool);
    console.log('Migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
