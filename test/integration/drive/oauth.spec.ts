import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import { DriveConnections } from '../../../src/drive/drive-connections.service';
import { createTestApp, testConfig } from '../support/app';
import { poolFor, startPostgres, startRedis } from '../support/containers';

/** Google Drive connection (SPEC §11) with Google's OAuth endpoints mocked by undici's MockAgent. */

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com';
/** Google answers JSON with its content type; gaxios parses bodies by it. */
const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };
const REFRESH_TOKEN = '1//refresh-token-of-alice';
const idToken = (claims: object) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('Google Drive connection (Postgres + Redis, mocked Google)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: NestFastifyApplication;
  let mock: MockAgent;
  let original: Dispatcher;
  let clientId: string;
  const alice: Record<string, string> = {};
  const bob: Record<string, string> = {};

  const google = () => mock.get(GOOGLE_TOKEN);
  /** The token endpoint answering one authorization-code exchange. */
  const grant = (claims: object = { email: 'alice@example.com' }) => {
    google()
      .intercept({
        path: '/token',
        method: 'POST',
        body: (body) => body.includes('grant_type=authorization_code'),
      })
      .reply(
        200,
        {
          access_token: 'ya29.access',
          refresh_token: REFRESH_TOKEN,
          id_token: idToken(claims),
          expires_in: 3599,
          token_type: 'Bearer',
        },
        JSON_HEADERS,
      );
  };
  const connect = async (headers = alice) => {
    const response = await app.inject({ method: 'POST', url: '/v1/drive/connect', headers });
    expect(response.statusCode, response.body).toBe(200);
    const { consent_url: consentUrl } = response.json<{ consent_url: string }>();
    return {
      consent: new URL(consentUrl),
      state: new URL(consentUrl).searchParams.get('state') ?? '',
    };
  };
  const callback = (query: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: `/oauth/google/callback?${new URLSearchParams(query).toString()}`,
    });

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const keys = new ApiKeyService(createDatabase(pool));
    const created = await keys.create({ clientName: 'drive', defaultUserId: 'alice' });
    clientId = created.clientId;
    alice.authorization = `Bearer ${created.key}`;
    bob.authorization = `Bearer ${(await keys.create({ clientName: 'drive', defaultUserId: 'bob' })).key}`;
    app = await createTestApp(
      testConfig({
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        API_RATE_LIMIT_PER_MINUTE: '100000',
        PUBLIC_BASE_URL: 'https://dl.example.test',
        GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'secret-456',
        TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
      }),
    );
    original = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
  });

  afterEach(() => {
    mock.assertNoPendingInterceptors();
  });

  afterAll(async () => {
    setGlobalDispatcher(original);
    await mock.close();
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('builds the consent URL with drive.file, offline access and a single-use state', async () => {
    const { consent, state } = await connect();
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(consent.searchParams)).toMatchObject({
      client_id: 'client-123.apps.googleusercontent.com',
      redirect_uri: 'https://dl.example.test/oauth/google/callback',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/drive.file openid email',
    });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await pool.query<{ user_id: string; expires_at: Date }>(
      'SELECT user_id, expires_at FROM oauth_states WHERE state = $1',
      [state],
    );
    expect(rows[0]?.user_id).toBe('alice');
    expect(rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('completes the callback, stores the refresh token encrypted and shows the account', async () => {
    const { state } = await connect();
    grant();
    const page = await callback({ state, code: '4/auth-code' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('Connected as alice@example.com');
    const { rows } = await pool.query<{ refresh_token_enc: string; status: string }>(
      'SELECT refresh_token_enc, status FROM drive_connections',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('connected');
    expect(rows[0]?.refresh_token_enc).not.toContain('refresh-token');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/drive/status', headers: alice })).json(),
    ).toMatchObject({
      connected: true,
      status: 'connected',
      google_email: 'alice@example.com',
      root_folder: null,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/drive/status', headers: bob })).json(),
    ).toMatchObject({ connected: false });
    // The state was single use.
    const again = await callback({ state, code: '4/auth-code' });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain('expired or was already used');
  });

  it('refuses unknown, expired and denied consents, and Google rejecting the code', async () => {
    expect((await callback({ state: 'made-up', code: 'x' })).body).toContain(
      'expired or was already used',
    );
    expect((await callback({ code: 'x' })).body).toContain('not valid');
    await pool.query(
      "INSERT INTO oauth_states (state, client_id, user_id, expires_at) VALUES ('old', $1, 'alice', now() - interval '1 minute')",
      [clientId],
    );
    expect((await callback({ state: 'old', code: 'x' })).statusCode).toBe(400);
    const denied = await connect();
    const deniedPage = await callback({ state: denied.state, error: 'access_denied' });
    expect(deniedPage.statusCode).toBe(400);
    expect(deniedPage.body).toContain('was not granted');
    const rejected = await connect();
    google()
      .intercept({ path: '/token', method: 'POST' })
      .reply(400, { error: 'invalid_grant', error_description: 'Bad Request' }, JSON_HEADERS);
    expect((await callback({ state: rejected.state, code: 'stale' })).body).toContain(
      'did not accept the sign-in',
    );
  });

  it('escapes what Google returns into the page', async () => {
    const { state } = await connect(bob);
    grant({ email: '<script>alert(1)</script>@example.com' });
    const page = await callback({ state, code: '4/other' });
    expect(page.body).not.toContain('<script>');
    expect(page.body).toContain('&lt;script&gt;');
  });

  it('refreshes access tokens and marks the connection revoked on invalid_grant', async () => {
    const connections = app.get(DriveConnections);
    google()
      .intercept({
        path: '/token',
        method: 'POST',
        body: (body) =>
          body.includes('grant_type=refresh_token') &&
          body.includes(encodeURIComponent(REFRESH_TOKEN)),
      })
      .reply(
        200,
        { access_token: 'ya29.fresh', expires_in: 3599, token_type: 'Bearer' },
        JSON_HEADERS,
      );
    expect((await connections.session({ clientId, userId: 'alice' })).accessToken).toBe(
      'ya29.fresh',
    );
    google().intercept({ path: '/token', method: 'POST' }).reply(
      400,
      {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      },
      JSON_HEADERS,
    );
    await expect(connections.session({ clientId, userId: 'alice' })).rejects.toMatchObject({
      code: 'DRIVE_RECONNECT_REQUIRED',
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/drive/status', headers: alice })).json(),
    ).toMatchObject({ connected: false, status: 'revoked' });
    // Revoked stays revoked until the user connects again: no more calls to Google.
    await expect(connections.session({ clientId, userId: 'alice' })).rejects.toMatchObject({
      code: 'DRIVE_RECONNECT_REQUIRED',
    });
    await expect(connections.session({ clientId, userId: 'carol' })).rejects.toMatchObject({
      code: 'DRIVE_NOT_CONNECTED',
    });
    // Connecting again restores it.
    const { state } = await connect();
    grant();
    await callback({ state, code: '4/again' });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/drive/status', headers: alice })).json(),
    ).toMatchObject({ status: 'connected' });
  });

  it('lists what the service created and keeps one root folder', async () => {
    const refresh = google()
      .intercept({
        path: '/token',
        method: 'POST',
        body: (body) => body.includes('grant_type=refresh_token'),
      })
      .reply(
        200,
        { access_token: 'ya29.list', expires_in: 3599, token_type: 'Bearer' },
        JSON_HEADERS,
      );
    refresh.persist();
    const api = mock.get('https://www.googleapis.com');
    const at = (pathname: string, param?: string) => (requested: string) => {
      const url = new URL(requested, 'https://www.googleapis.com');
      return url.pathname === pathname && (param === undefined || url.searchParams.has(param));
    };
    api
      .intercept({
        path: at('/drive/v3/files', 'q'),
        method: 'GET',
        headers: { authorization: 'Bearer ya29.list' },
      })
      .reply(
        200,
        {
          files: [
            {
              id: 'fold',
              name: 'Media downloads',
              mimeType: 'application/vnd.google-apps.folder',
              createdTime: '2026-10-31T00:00:00Z',
            },
            {
              id: 'vid',
              name: 'a.mp4',
              mimeType: 'video/mp4',
              size: '1234',
              parents: ['fold'],
              webViewLink: 'https://drive.google.com/file/d/vid/view',
            },
          ],
          nextPageToken: 'page-2~token',
        },
        JSON_HEADERS,
      );
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/drive/files?limit=2',
      headers: alice,
    });
    expect(listed.json()).toEqual({
      files: [
        {
          id: 'fold',
          name: 'Media downloads',
          mime: 'application/vnd.google-apps.folder',
          is_folder: true,
          size_bytes: null,
          link: 'https://drive.google.com/drive/folders/fold',
          parent_id: null,
          created_at: '2026-10-31T00:00:00Z',
        },
        {
          id: 'vid',
          name: 'a.mp4',
          mime: 'video/mp4',
          is_folder: false,
          size_bytes: 1234,
          link: 'https://drive.google.com/file/d/vid/view',
          parent_id: 'fold',
          created_at: null,
        },
      ],
      next_cursor: 'page-2~token',
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/drive/files?cursor=has%20space',
          headers: alice,
        })
      ).statusCode,
    ).toBe(400);

    const connections = app.get(DriveConnections);
    const owner = { clientId, userId: 'alice' };
    const { client } = await connections.client(owner);
    api
      .intercept({ path: at('/drive/v3/files', 'fields'), method: 'POST' })
      .reply(
        200,
        { id: 'root-1', name: 'Media downloads', mimeType: 'application/vnd.google-apps.folder' },
        JSON_HEADERS,
      );
    expect(await connections.ensureRoot(owner, client)).toBe('root-1');
    api
      .intercept({ path: at('/drive/v3/files/root-1'), method: 'GET' })
      .reply(
        200,
        { id: 'root-1', name: 'Media downloads', mimeType: 'application/vnd.google-apps.folder' },
        JSON_HEADERS,
      );
    expect(await connections.ensureRoot(owner, client)).toBe('root-1');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/drive/status', headers: alice })).json(),
    ).toMatchObject({
      root_folder: { id: 'root-1', link: 'https://drive.google.com/drive/folders/root-1' },
    });
    // The user deleted it: a new one is made.
    api
      .intercept({ path: at('/drive/v3/files/root-1'), method: 'GET' })
      .reply(404, { error: { code: 404 } }, JSON_HEADERS);
    api
      .intercept({ path: at('/drive/v3/files', 'fields'), method: 'POST' })
      .reply(
        200,
        { id: 'root-2', name: 'Media downloads', mimeType: 'application/vnd.google-apps.folder' },
        JSON_HEADERS,
      );
    expect(await connections.ensureRoot(owner, client)).toBe('root-2');
  });

  it('revokes the token at Google on disconnect and forgets the connection', async () => {
    google()
      .intercept({ path: `/revoke?token=${encodeURIComponent(REFRESH_TOKEN)}`, method: 'POST' })
      .reply(200, {}, JSON_HEADERS);
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/drive/connection',
      headers: alice,
    });
    expect(response.json()).toEqual({ disconnected: true, revoked_at_google: true });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/drive/status', headers: alice })).json(),
    ).toMatchObject({ status: 'not_connected' });
    const again = await app.inject({
      method: 'DELETE',
      url: '/v1/drive/connection',
      headers: alice,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'DRIVE_NOT_CONNECTED' } });
    // Google unreachable: the connection is still removed, and the answer says so.
    google()
      .intercept({ path: /^\/revoke/, method: 'POST' })
      .reply(503, 'unavailable');
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/drive/connection', headers: bob })).json(),
    ).toEqual({
      disconnected: true,
      revoked_at_google: false,
    });
  });
});
