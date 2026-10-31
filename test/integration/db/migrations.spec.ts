import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../src/common/ids';
import { runMigrations } from '../../../src/db/migrations';
import { createDatabase, poolFor, startPostgres } from '../support/containers';

const journal = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../drizzle/meta/_journal.json'), 'utf8'),
) as { entries: unknown[] };
const MIGRATION_COUNT = String(journal.entries.length);

describe('database migrations (Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await startPostgres();
    pool = poolFor(container.getConnectionUri());
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('creates the tables', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'api_keys',
      'archive',
      'clients',
      'cookie_jars',
      'drive_connections',
      'inputs',
      'job_logs',
      'jobs',
      'media_files',
      'oauth_states',
      'outputs',
      'playlists',
      'recipes',
      'site_credentials',
      'uploads',
      'watch_runs',
      'watch_seen',
      'watches',
    ]);
  });

  it('does nothing when run again', async () => {
    const count = async () =>
      (await pool.query<{ n: string }>('SELECT count(*) AS n FROM drizzle.__drizzle_migrations'))
        .rows[0]?.n;
    const before = await count();
    await runMigrations(pool);
    expect(await count()).toBe(before);
  });

  it('serialises concurrent runs on a fresh database', async () => {
    const fresh = poolFor(await createDatabase(container, 'concurrent'), 6);
    try {
      await Promise.all([runMigrations(fresh), runMigrations(fresh), runMigrations(fresh)]);
      const { rows } = await fresh.query<{ n: string }>(
        'SELECT count(*) AS n FROM drizzle.__drizzle_migrations',
      );
      expect(rows[0]?.n).toBe(MIGRATION_COUNT);
    } finally {
      await fresh.end();
    }
  });

  it('enforces unique key hashes and prefixes, and removes keys with their client', async () => {
    const clientId = uuidv7();
    await pool.query('INSERT INTO clients (id, name) VALUES ($1, $2)', [clientId, 'app-one']);
    const insertKey = (hash: string, prefix: string) =>
      pool.query('INSERT INTO api_keys (id, client_id, key_hash, prefix) VALUES ($1, $2, $3, $4)', [
        uuidv7(),
        clientId,
        hash,
        prefix,
      ]);
    await insertKey('hash-1', 'mk_aaaaaaaa');
    await expect(insertKey('hash-1', 'mk_bbbbbbbb')).rejects.toMatchObject({ code: '23505' });
    await expect(insertKey('hash-2', 'mk_aaaaaaaa')).rejects.toMatchObject({ code: '23505' });

    await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    const { rows } = await pool.query('SELECT 1 FROM api_keys WHERE client_id = $1', [clientId]);
    expect(rows).toHaveLength(0);
  });

  it('rejects duplicate client names', async () => {
    await pool.query('INSERT INTO clients (id, name) VALUES ($1, $2)', [uuidv7(), 'app-two']);
    await expect(
      pool.query('INSERT INTO clients (id, name) VALUES ($1, $2)', [uuidv7(), 'app-two']),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
