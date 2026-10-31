import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView } from '../../../src/jobs/jobs.service';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import {
  CALLS_LOG,
  ensureFakeMedia,
  fakeCalls,
  FINISHED,
  type JobStack,
  startJobStack,
} from '../support/jobs';

/** Access options end to end (SPEC §7f): the vault, sealed secrets, proxies, geo and dedup scope. */

const PROXY = 'http://user:pw@proxy.test:8080';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const jar = (sid: string) => ['.fake.test', 'TRUE', '/', 'TRUE', '0', 'SID', sid].join('\t');

interface AccessLine {
  sid: string | null;
  proxy: string | null;
  xff: string | null;
  markWatched: boolean;
  extractorArgs: string[];
  username: string | null;
  twofactor: string | null;
  videoPassword: string | null;
  apMso: string | null;
}

/** What the fake yt-dlp saw for a guarded URL, one entry per run (info, then download). */
function accessLog(name: string): AccessLine[] {
  if (!existsSync(CALLS_LOG)) return [];
  const prefix = `access ${name} `;
  return readFileSync(CALLS_LOG, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as AccessLine);
}

describe('access options (Postgres + Redis + workers)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  const auth: Record<string, string> = {};
  const as = (user: string) => ({ ...auth, 'x-user-id': user });

  const putCookies = (user: string, sid: string) =>
    stack.app.inject({
      method: 'PUT',
      url: '/v1/cookies',
      headers: as(user),
      payload: { cookies: jar(sid) },
    });
  const start = async (payload: object, user = 'alice') => {
    const response = await stack.create({ type: 'download', ...payload }, { 'x-user-id': user });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<JobView>();
  };
  /** Like stack.waitFor, for any user (jobs are visible only to their owner). */
  const waitAs = async (id: string, user: string): Promise<JobView> => {
    for (let i = 0; i < 200; i++) {
      const view = (
        await stack.app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: as(user) })
      ).json<JobView>();
      if (FINISHED.includes(view.status)) return view;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`job ${id} did not finish`);
  };
  const finish = async (payload: object, user = 'alice') =>
    waitAs((await start(payload, user)).id, user);
  const storedOptions = async (id: string) =>
    (
      await pool.query<{ options: Record<string, unknown> }>(
        'SELECT options FROM jobs WHERE id = $1',
        [id],
      )
    ).rows[0]?.options ?? {};

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const created = await new ApiKeyService(createDatabase(pool)).create({ clientName: 'access' });
    Object.assign(auth, { authorization: `Bearer ${created.key}`, 'x-user-id': 'alice' });
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        PROXY_POOL: JSON.stringify({ res: PROXY }),
        PROXY_DEFAULT_BY_EXTRACTOR: JSON.stringify({ youtube: 'res' }),
        GEO_BYPASS_ALLOWLIST: 'GB,US',
        YTDLP_ALLOWED_PLAYER_CLIENTS: 'tv,web_safari',
        SITE_CREDENTIALS_ENABLED: 'true',
      },
      auth,
    );
  });

  beforeEach(() => {
    rmSync(CALLS_LOG, { force: true });
  });

  afterAll(async () => {
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('needs the user’s cookie jar for members-only media and shreds the job-local copy', async () => {
    const refused = await finish({ url: 'https://fake.test/members' });
    expect(refused).toMatchObject({ status: 'failed', error: { code: 'LOGIN_REQUIRED' } });
    expect((await putCookies('alice', 'alice-sid')).statusCode).toBe(200);
    const done = await finish({ url: 'https://fake.test/members', cookies: true });
    expect(done.status).toBe('completed');
    expect(accessLog('members').map((line) => line.sid)).toEqual([null, 'alice-sid', 'alice-sid']);
    expect(readdirSync(path.join(stack.filesDir, '.work'))).toEqual([]);
  });

  it('never reuses media fetched with one user’s cookies for another user', async () => {
    expect((await putCookies('bob', 'bob-sid')).statusCode).toBe(200);
    expect((await finish({ url: 'https://fake.test/members', cookies: true }, 'bob')).status).toBe(
      'completed',
    );
    expect(fakeCalls('download members')).toBe(1);
    expect(accessLog('members').map((line) => line.sid)).toEqual(['bob-sid', 'bob-sid']);
    // The same user with the same access is reused.
    expect((await finish({ url: 'https://fake.test/members', cookies: true }, 'bob')).status).toBe(
      'completed',
    );
    expect(fakeCalls('download members')).toBe(1);
  });

  it('passes proxy, geo, extractor args and mark_watched, and applies the default proxy per extractor', async () => {
    const done = await finish({
      url: 'https://fake.test/members',
      cookies: true,
      proxy: 'res',
      geo_country: 'GB',
      mark_watched: true,
      extractor_args: { youtube: { player_client: ['tv'], lang: 'de' } },
    });
    expect(done.status).toBe('completed');
    const [info] = accessLog('members');
    expect(info).toMatchObject({ proxy: PROXY, xff: 'GB', markWatched: true });
    expect(info?.extractorArgs).toContain('youtube:player_client=tv;lang=de');
    expect(done.options).toMatchObject({ proxy: 'res', geo_country: 'GB' });
    expect(JSON.stringify(done)).not.toContain('pw@');

    // No proxy named: the URL (fake.test) matches no default, the extracted "youtube" does.
    rmSync(CALLS_LOG, { force: true });
    await finish({ url: 'https://fake.test/members', cookies: true, preset: '360p' });
    expect(accessLog('members').map((line) => line.proxy)).toEqual([null, PROXY]);
  });

  it('seals video passwords: never stored or shown in clear, gone once the job is done', async () => {
    const job = await start({ url: 'https://fake.test/locked', video_password: 'opensesame' });
    const stored = await storedOptions(job.id);
    expect(JSON.stringify(stored)).not.toContain('opensesame');
    expect(JSON.stringify(job)).not.toMatch(/opensesame|_secrets|video_password/);
    const done = await stack.waitFor(job.id);
    expect(done.status).toBe('completed');
    expect(accessLog('locked').map((line) => line.videoPassword)).toEqual([
      'opensesame',
      'opensesame',
    ]);
    expect(await storedOptions(job.id)).not.toHaveProperty('_secrets');

    const wrong = await finish({ url: 'https://fake.test/locked', video_password: 'guess' });
    expect(wrong).toMatchObject({ status: 'failed' });
    expect(await storedOptions(wrong.id)).not.toHaveProperty('_secrets');
  });

  it('hands sealed secrets to playlist items and clears them from parent and items', async () => {
    const parent = await start({
      url: 'https://fake.test/playlist',
      video_password: 'opensesame',
      max_items: 2,
    });
    const done = await stack.waitFor(parent.id);
    expect(done.status).toBe('completed');
    const { rows } = await pool.query<{ options: Record<string, unknown> }>(
      'SELECT options FROM jobs WHERE id = $1 OR parent_job_id = $1',
      [parent.id],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.options).not.toHaveProperty('_secrets');
      expect(JSON.stringify(row.options)).not.toContain('opensesame');
    }
  });

  it('logs in with stored credentials and a fresh TOTP code', async () => {
    const saved = await stack.app.inject({
      method: 'PUT',
      url: '/v1/credentials/fake',
      headers: auth,
      payload: { username: 'alice@example.com', password: 'hunter2', totp_seed: SEED },
    });
    expect(saved.json()).toEqual({
      site_key: 'fake',
      username: 'alice@example.com',
      has_totp: true,
    });
    const done = await finish({ url: 'https://fake.test/login', credentials: 'fake' });
    expect(done.status).toBe('completed');
    const [info] = accessLog('login');
    expect(info).toMatchObject({ username: 'alice@example.com' });
    expect(info?.twofactor).toMatch(/^\d{6}$/);
  });

  it('refuses access options the server or the user cannot satisfy', async () => {
    const refusal = async (payload: object, user = 'alice') => {
      const response = await stack.create(
        { type: 'download', url: 'https://fake.test/video', ...payload },
        { 'x-user-id': user },
      );
      return {
        status: response.statusCode,
        error: response.json<{ error: { code: string; message: string } }>().error,
      };
    };
    expect(await refusal({ cookies: true }, 'carol')).toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/no cookie jar/) as string },
    });
    expect(await refusal({ cookies: '01890000-0000-7000-8000-000000000000' })).toMatchObject({
      status: 400,
    });
    expect(await refusal({ credentials: 'vimeo' })).toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/no credentials for "vimeo"/) as string },
    });
    expect(await refusal({ proxy: 'nope' })).toMatchObject({
      status: 400,
      error: { message: 'proxy "nope" is not configured; available: res' },
    });
    expect(await refusal({ proxy: 'http://evil:1' })).toMatchObject({ status: 400 });
    expect(await refusal({ geo_country: 'FR' })).toMatchObject({
      status: 400,
      error: { message: 'geo_country must be one of GB, US' },
    });
    expect(
      await refusal({ extractor_args: { youtube: { player_client: ['android'] } } }),
    ).toMatchObject({
      status: 400,
      error: {
        message: expect.stringMatching(
          /player_client android is not allowed; allowed: tv, web_safari/,
        ) as string,
      },
    });
    expect(await refusal({ extractor_args: { youtube: { po_token: 'x' } } })).toMatchObject({
      status: 400,
    });
    expect(await refusal({ mark_watched: true })).toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/mark_watched requires cookies/) as string },
    });
    expect(
      await refusal({ tv_provider: { mso: 'Comcast_SSO', username: 'a', password: 'b' } }),
    ).toMatchObject({ status: 501, error: { code: 'FEATURE_DISABLED' } });
    expect(await refusal({ break_on_existing: true })).toMatchObject({ status: 501 });
    const batch = await stack.create({
      type: 'batch',
      items: [
        { url: 'https://fake.test/video' },
        { url: 'https://fake.test/video', proxy: 'nope' },
      ],
    });
    expect(batch.json()).toMatchObject({
      error: { message: expect.stringMatching(/^items\.1: proxy "nope"/) as string },
    });
  });
});
