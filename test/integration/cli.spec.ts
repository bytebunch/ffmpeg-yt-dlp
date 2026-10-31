import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_KEY_PATTERN, ApiKeyService } from '../../src/auth/api-keys';
import { runCli } from '../../src/cli';
import { AppError } from '../../src/common/errors';
import { createDatabase } from '../../src/db/database';
import { runMigrations } from '../../src/db/migrations';
import { poolFor, startPostgres } from './support/containers';

describe('cli against Postgres', () => {
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let keys: ApiKeyService;

  beforeAll(async () => {
    postgres = await startPostgres();
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    keys = new ApiKeyService(createDatabase(pool));
  });

  afterAll(async () => {
    await pool.end();
    await postgres.stop();
  });

  async function cli(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const reencrypt = () => Promise.resolve({ cookies: 0, credentials: 0, drive: 0 });
    const code = await runCli(
      args,
      { keys, reencrypt },
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
    );
    return { code, out, err };
  }

  it('creates, lists, authenticates and revokes a key end to end', async () => {
    const created = await cli('keys:create', 'default', '--quiet');
    expect(created.code).toBe(0);
    const [key] = created.out;
    expect(key).toMatch(API_KEY_PATTERN);
    if (key === undefined) throw new Error('no key printed');

    expect(await keys.authenticate(key)).toMatchObject({ clientName: 'default' });
    const listed = await cli('keys:list', '--client', 'default');
    expect(listed.out[1]?.startsWith(`${key.slice(0, 11)}\tdefault\t`)).toBe(true);

    expect((await cli('keys:revoke', '--key', key)).code).toBe(0);
    expect(await keys.authenticate(key)).toBeUndefined();
    expect((await cli('keys:revoke', '--key', key)).code).toBe(1);
  });

  it('revokes by prefix and keeps other keys of the client working', async () => {
    const first = await keys.create({ clientName: 'two-keys' });
    const second = await keys.create({ clientName: 'two-keys' });
    expect((await cli('keys:revoke', first.prefix)).code).toBe(0);
    expect(await keys.authenticate(first.key)).toBeUndefined();
    expect(await keys.authenticate(second.key)).toBeDefined();
    expect(second.clientId).toBe(first.clientId);
  });

  it('refuses client names that are not path-safe', async () => {
    await expect(cli('keys:create', '../etc')).rejects.toBeInstanceOf(AppError);
  });
});
