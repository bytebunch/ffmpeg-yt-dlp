import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CookiesService } from '../../../src/access/cookies.service';
import { CredentialsService } from '../../../src/access/credentials.service';
import { ApiKeyService } from '../../../src/auth/api-keys';
import { totp } from '../../../src/common/secrets';
import type { AppConfig } from '../../../src/config/env.schema';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import { createTestApp, testConfig } from '../support/app';
import { poolFor, startPostgres, startRedis } from '../support/containers';

/** The cookie and credential vault (SPEC §4, §7f, §12) over REST, with real Postgres. */

const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const jar = (domain: string, value = 'secret-cookie-value') =>
  [
    '# Netscape HTTP Cookie File',
    ['.' + domain, 'TRUE', '/', 'TRUE', '0', 'SID', value].join('\t'),
  ].join('\n');

interface JarView {
  id: string;
  label: string;
  domains: string[];
  is_default: boolean;
}

describe('cookie and credential vault (Postgres + Redis)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let env: Record<string, string>;
  let config: AppConfig;
  let app: NestFastifyApplication;
  let alice: Record<string, string>;
  let bob: Record<string, string>;

  const request = (
    method: 'GET' | 'PUT' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const keys = new ApiKeyService(createDatabase(pool));
    alice = {
      authorization: `Bearer ${(await keys.create({ clientName: 'vault', defaultUserId: 'alice' })).key}`,
    };
    bob = {
      authorization: `Bearer ${(await keys.create({ clientName: 'vault', defaultUserId: 'bob' })).key}`,
    };
    env = {
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      API_RATE_LIMIT_PER_MINUTE: '100000',
      TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    };
    config = testConfig(env);
    app = await createTestApp(config);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('stores jars encrypted, never returns their contents and replaces a jar by label', async () => {
    const first = await request('PUT', '/v1/cookies', alice, {
      cookies: jar('youtube.com'),
      label: 'youtube',
    });
    expect(first.statusCode).toBe(200);
    const saved = first.json<JarView>();
    expect(saved).toMatchObject({
      label: 'youtube',
      domains: ['youtube.com'],
      is_default: true,
      cookie_count: 1,
    });
    expect(first.body).not.toContain('secret-cookie-value');
    const { rows } = await pool.query<{ jar_enc: string; key_version: number }>(
      'SELECT jar_enc, key_version FROM cookie_jars',
    );
    expect(rows[0]?.jar_enc).toMatch(/^v1\./);
    expect(rows[0]?.jar_enc).not.toContain('secret');
    const replaced = (
      await request('PUT', '/v1/cookies', alice, {
        cookies: jar('youtube.com', 'new-value'),
        label: 'youtube',
      })
    ).json<JarView>();
    expect(replaced.id).toBe(saved.id);
    const text = await app
      .get(CookiesService)
      .jarText({ clientId: await clientId(), userId: 'alice' }, true);
    expect(text).toContain('new-value');
    expect(text.startsWith('# Netscape HTTP Cookie File')).toBe(true);
  });

  it('keeps one default jar per user and promotes another when the default is deleted', async () => {
    const vimeo = (
      await request('PUT', '/v1/cookies', alice, { cookies: jar('vimeo.com'), label: 'vimeo' })
    ).json<JarView>();
    expect(vimeo.is_default).toBe(false);
    const switched = (
      await request('PUT', '/v1/cookies', alice, {
        cookies: jar('vimeo.com'),
        label: 'vimeo',
        default: true,
      })
    ).json<JarView>();
    expect(switched.is_default).toBe(true);
    const listed = (await request('GET', '/v1/cookies', alice)).json<{ cookies: JarView[] }>()
      .cookies;
    expect(listed.filter((entry) => entry.is_default).map((entry) => entry.label)).toEqual([
      'vimeo',
    ]);
    expect((await request('DELETE', `/v1/cookies/${vimeo.id}`, alice)).json()).toEqual({
      removed: 1,
    });
    const after = (await request('GET', '/v1/cookies', alice)).json<{ cookies: JarView[] }>()
      .cookies;
    expect(after.map((entry) => [entry.label, entry.is_default])).toEqual([['youtube', true]]);
  });

  it('scopes jars to their user', async () => {
    const [aliceJar] = (await request('GET', '/v1/cookies', alice)).json<{ cookies: JarView[] }>()
      .cookies;
    expect((await request('GET', '/v1/cookies', bob)).json()).toEqual({ cookies: [] });
    expect((await request('DELETE', `/v1/cookies/${aliceJar?.id ?? ''}`, bob)).statusCode).toBe(
      404,
    );
    expect((await request('DELETE', '/v1/cookies/not-a-uuid', bob)).statusCode).toBe(404);
    await expect(
      app.get(CookiesService).jarText({ clientId: await clientId(), userId: 'bob' }, true),
    ).rejects.toThrow(/no cookie jar/);
  });

  it('refuses JSON exports, invalid rows and expired jars', async () => {
    const json = await request('PUT', '/v1/cookies', bob, {
      cookies: '[{"name":"SID","value":"x"}]',
    });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/not JSON/) as string },
    });
    const expired = ['.a.com', 'TRUE', '/', 'TRUE', '1000', 'SID', 'x'].join('\t');
    expect((await request('PUT', '/v1/cookies', bob, { cookies: expired })).json()).toMatchObject({
      error: { message: expect.stringMatching(/no unexpired/) as string },
    });
    expect(
      (await request('PUT', '/v1/cookies', bob, { cookies: jar('a.com'), extra: 1 })).statusCode,
    ).toBe(400);
  });

  it('deletes every jar of a user', async () => {
    await request('PUT', '/v1/cookies', bob, { cookies: jar('a.com'), label: 'a' });
    await request('PUT', '/v1/cookies', bob, { cookies: jar('b.com'), label: 'b' });
    expect((await request('DELETE', '/v1/cookies', bob)).json()).toEqual({ removed: 2 });
    expect(
      (await request('GET', '/v1/cookies', alice)).json<{ cookies: unknown[] }>().cookies,
    ).toHaveLength(1);
  });

  it('refuses credentials while SITE_CREDENTIALS_ENABLED is off', async () => {
    const put = await request('PUT', '/v1/credentials/vimeo', alice, {
      username: 'a@b.c',
      password: 'pw',
    });
    expect(put.statusCode).toBe(501);
    expect(put.json()).toMatchObject({ error: { code: 'FEATURE_DISABLED' } });
    expect((await request('DELETE', '/v1/credentials/vimeo', alice)).statusCode).toBe(404);
  });

  it('stores credentials encrypted and produces the TOTP code when enabled', async () => {
    const enabled = testConfig({ ...env, SITE_CREDENTIALS_ENABLED: 'true' });
    const vault = new CredentialsService(enabled, createDatabase(pool));
    const owner = { clientId: await clientId(), userId: 'alice' };
    const auth = { ...owner, clientName: 'vault', keyId: 'k', shareOutputsWithinClient: false };
    expect(
      await vault.put(auth, 'vimeo', { username: 'a@b.c', password: 'hunter2', totp_seed: SEED }),
    ).toEqual({
      site_key: 'vimeo',
      username: 'a@b.c',
      has_totp: true,
    });
    const { rows } = await pool.query<{ secret_enc: string }>(
      'SELECT secret_enc FROM site_credentials',
    );
    expect(rows[0]?.secret_enc).not.toContain('hunter2');
    const now = Date.UTC(2026, 9, 31, 12);
    expect(await vault.login(owner, 'vimeo', now)).toEqual({
      username: 'a@b.c',
      password: 'hunter2',
      twoFactor: totp(SEED, now),
    });
    await expect(vault.login({ ...owner, userId: 'bob' }, 'vimeo')).rejects.toThrow(
      /no credentials/,
    );
    await expect(vault.put(auth, 'Bad Site', { username: 'x', password: 'y' })).rejects.toThrow(
      /site key/,
    );
    expect(await vault.remove(auth, 'vimeo')).toEqual({ removed: 1 });
  });

  it('re-encrypts jars and credentials with a new key so the old key can be retired', async () => {
    const enabled = testConfig({ ...env, SITE_CREDENTIALS_ENABLED: 'true' });
    const owner = { clientId: await clientId(), userId: 'alice' };
    await new CredentialsService(enabled, createDatabase(pool)).put(
      { ...owner, clientName: 'vault', keyId: 'k', shareOutputsWithinClient: false },
      'vimeo',
      { username: 'u', password: 'p' },
    );
    const v2 = `v2:${randomBytes(32).toString('base64')}`;
    const rotated = testConfig({
      ...env,
      SITE_CREDENTIALS_ENABLED: 'true',
      TOKEN_ENCRYPTION_KEYS: `${v2},${env.TOKEN_ENCRYPTION_KEYS ?? ''}`,
    });
    const db = createDatabase(pool);
    expect(await new CookiesService(rotated, db).reencrypt()).toBe(1);
    expect(await new CredentialsService(rotated, db).reencrypt()).toBe(1);
    expect(await new CookiesService(rotated, db).reencrypt()).toBe(0);
    const retired = testConfig({
      ...env,
      SITE_CREDENTIALS_ENABLED: 'true',
      TOKEN_ENCRYPTION_KEYS: v2,
    });
    expect(await new CookiesService(retired, db).jarText(owner, true)).toContain('new-value');
    expect((await new CredentialsService(retired, db).login(owner, 'vimeo')).password).toBe('p');
  });

  async function clientId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM clients WHERE name = 'vault'",
    );
    return rows[0]?.id ?? '';
  }
});
