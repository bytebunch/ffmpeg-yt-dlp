import { existsSync, readFileSync, rmSync } from 'node:fs';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import { URL_RESOLVER } from '../../../src/discovery/discovery.service';
import type { Resolver } from '../../../src/ytdlp/url-guard';
import { createTestApp, testConfig } from '../support/app';
import { poolFor, startPostgres, startRedis } from '../support/containers';

/** Every test host resolves to a public address; the fake yt-dlp answers by URL path. */
const publicResolver: Resolver = () => Promise.resolve(['93.184.215.14']);

const CALLS_LOG = '/tmp/fake-yt-dlp-calls.log';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const jar = (sid: string) => ['.fake.test', 'TRUE', '/', 'TRUE', '0', 'SID', sid].join('\t');

interface AccessLine {
  sid: string | null;
  cookieFile: string | null;
  username: string | null;
  twofactor: string | null;
}

/** What the fake yt-dlp saw on its latest run for a guarded URL or a search. */
function lastAccess(name: string): AccessLine | undefined {
  if (!existsSync(CALLS_LOG)) return undefined;
  const prefix = `access ${name} `;
  const line = readFileSync(CALLS_LOG, 'utf8')
    .split('\n')
    .filter((entry) => entry.startsWith(prefix))
    .at(-1);
  return line === undefined ? undefined : (JSON.parse(line.slice(prefix.length)) as AccessLine);
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe('discovery endpoints (fake yt-dlp, Postgres + Redis)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: NestFastifyApplication;
  let auth: Record<string, string>;

  const env = () => ({
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
  });
  const build = (extra: Record<string, string> = {}) =>
    createTestApp(testConfig({ ...env(), ...extra }), {
      overrides: [{ token: URL_RESOLVER, value: publicResolver }],
    });

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const { key } = await new ApiKeyService(createDatabase(pool)).create({
      clientName: 'discovery',
    });
    auth = { authorization: `Bearer ${key}` };
    app = await build();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: auth, payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

  it('requires an API key on every discovery route', async () => {
    for (const [method, url] of [
      ['POST', '/v1/info'],
      ['GET', '/v1/search?q=x'],
      ['POST', '/v1/transcripts'],
      ['POST', '/v1/comments'],
      ['GET', '/v1/presets'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
  });

  describe('POST /v1/info', () => {
    it('returns video metadata without heavy parts or stream URLs', async () => {
      const response = await post('/v1/info', {
        url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        type: 'video',
        id: 'jNQXAC9IVRw',
        title: 'Me at the zoo',
      });
      expect(response.json()).not.toHaveProperty('formats');
      expect(response.body).not.toContain('media.invalid');
    });

    it('adds the requested parts and accepts a preset', async () => {
      const response = await post('/v1/info', {
        url: 'https://fake.test/video',
        include: ['formats', 'chapters', 'subtitles'],
        preset: '720p',
      });
      const body = response.json<{ formats: unknown[]; chapters: unknown[]; subtitles: object }>();
      expect(response.statusCode).toBe(200);
      expect(body.formats).toHaveLength(6);
      expect(body.chapters).toHaveLength(3);
      expect(Object.keys(body.subtitles)).toEqual(['en']);
      expect(response.body).not.toContain('media.invalid');
    });

    it('pages through a playlist with cursors', async () => {
      const titles: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const response = await post('/v1/info', {
          url: 'https://fake.test/playlist',
          mode: 'playlist',
          limit: 4,
          ...(cursor ? { cursor } : {}),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json<{
          entries: { index: number; title: string }[];
          next_cursor: string | null;
        }>();
        titles.push(...body.entries.map((entry) => `${entry.index}:${entry.title}`));
        cursor = body.next_cursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(titles).toEqual(Array.from({ length: 10 }, (_, i) => `${i + 1}:Video ${i + 1}`));
    });

    it('refuses a playlist in single mode and rejects bad cursors', async () => {
      const single = await post('/v1/info', { url: 'https://fake.test/playlist', mode: 'single' });
      expect(single.statusCode).toBe(400);
      expect(single.json<ErrorBody>().error.message).toMatch(/is a playlist/);
      const cursor = await post('/v1/info', { url: 'https://fake.test/playlist', cursor: 'nope' });
      expect(cursor.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
    });

    it('maps yt-dlp failures to stable codes', async () => {
      const privateVideo = await post('/v1/info', { url: 'https://fake.test/private' });
      expect(privateVideo.statusCode).toBe(403);
      expect(privateVideo.json<ErrorBody>().error).toMatchObject({ code: 'MEDIA_PRIVATE' });
      const unsupported = await post('/v1/info', { url: 'https://fake.test/unknown' });
      expect(unsupported.json<ErrorBody>().error.code).toBe('UNSUPPORTED_SITE');
    });

    it('refuses private addresses before yt-dlp runs', async () => {
      for (const url of [
        'http://10.0.0.1/video',
        'http://169.254.169.254/latest',
        'http://[::1]/',
      ]) {
        const response = await post('/v1/info', { url });
        expect(response.statusCode).toBe(400);
        expect(response.json<ErrorBody>().error.code).toBe('URL_NOT_ALLOWED');
      }
    });

    it('validates the body', async () => {
      const response = await post('/v1/info', {
        url: 'https://fake.test/video',
        include: ['secrets'],
        extra: true,
      });
      expect(response.statusCode).toBe(400);
      const paths = (response.json<ErrorBody>().error.details?.issues as { path: string }[]).map(
        (issue) => issue.path,
      );
      expect(paths).toEqual(expect.arrayContaining(['include.0', '']));
    });
  });

  describe('GET /v1/search', () => {
    it('returns at most limit results', async () => {
      const response = await get('/v1/search?q=me%20at%20the%20zoo&limit=2');
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        site: string;
        results: { id: string; title: string; url: string }[];
      }>();
      expect(body.site).toBe('youtube');
      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toMatchObject({ id: 'result1', title: 'Me at the zoo' });
    });

    it('sorts YouTube by date and refuses date order where unsupported', async () => {
      expect(
        (await get('/v1/search?q=cats&sort=date&limit=3')).json<{ results: unknown[] }>().results,
      ).toHaveLength(3);
      const bilibili = await get('/v1/search?q=cats&site=bilibili&sort=date');
      expect(bilibili.statusCode).toBe(400);
    });

    it('validates the query', async () => {
      for (const query of [
        'q=',
        'q=x&limit=0',
        'q=x&limit=51',
        'q=x&site=vimeo',
        'q=a%0Ab',
        'q=x&debug=1',
      ]) {
        expect((await get(`/v1/search?${query}`)).statusCode).toBe(400);
      }
    });
  });

  describe('POST /v1/transcripts', () => {
    const url = 'https://fake.test/video';

    it('returns cues from the manual English track by default', async () => {
      const response = await post('/v1/transcripts', { url });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        language: string;
        automatic: boolean;
        cues: { text: string }[];
      }>();
      expect(body).toMatchObject({
        id: 'jNQXAC9IVRw',
        language: 'en',
        automatic: false,
        format: 'json',
      });
      expect(body.cues).toHaveLength(6);
    });

    it.each([
      ['srt', /^1\n00:00:01,200 --> 00:00:03,360\nAll right/],
      ['vtt', /^WEBVTT\n\n00:00:01\.200 --> 00:00:03\.360\n/],
      ['txt', /^All right, so here we are, in front of the\nelephants\n/],
    ])('renders %s', async (format, pattern) => {
      const response = await post('/v1/transcripts', { url, format });
      expect(response.json<{ content: string }>().content).toMatch(pattern);
    });

    it('falls back through the language list and de-duplicates automatic captions', async () => {
      const response = await post('/v1/transcripts', { url, lang: ['fr', 'es'] });
      expect(response.json()).toMatchObject({
        language: 'es',
        automatic: true,
        cues: [
          { text: 'hola a todos' },
          { text: 'bienvenidos al canal' },
          { text: '& gracias <3' },
        ],
      });
    });

    it('answers NOT_FOUND with the available languages', async () => {
      const response = await post('/v1/transcripts', { url, lang: ['es'], auto: false });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.details).toEqual({
        subtitles: ['en'],
        automatic_captions: [],
      });
      const none = await post('/v1/transcripts', { url: 'https://fake.test/nosubs' });
      expect(none.statusCode).toBe(404);
    });

    it('rejects language patterns, which yt-dlp would treat as regular expressions', async () => {
      expect((await post('/v1/transcripts', { url, lang: ['.*'] })).statusCode).toBe(400);
    });
  });

  describe('POST /v1/comments', () => {
    it('returns up to max comments', async () => {
      const response = await post('/v1/comments', {
        url: 'https://fake.test/video',
        max: 3,
        sort: 'new',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ comments: { parent: unknown }[] }>();
      expect(body.comments).toHaveLength(3);
      expect(body.comments[0]?.parent).toBeNull();
    });

    it('caps synchronous requests at COMMENTS_SYNC_MAX', async () => {
      const response = await post('/v1/comments', { url: 'https://fake.test/video', max: 201 });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.details).toEqual({ max: 200 });
    });
  });

  describe('GET /v1/presets and OpenAPI', () => {
    it('lists presets, sites and the request schemas', async () => {
      const body = (await get('/v1/presets')).json<{
        download_presets: { name: string }[];
        search_sites: string[];
        request_schemas: Record<string, { properties: Record<string, unknown> }>;
      }>();
      expect(body.download_presets).toHaveLength(17);
      expect(body.search_sites).toEqual(['youtube', 'soundcloud', 'bilibili', 'niconico']);
      expect(Object.keys(body.request_schemas.info?.properties ?? {})).toEqual(
        expect.arrayContaining(['url', 'include', 'mode', 'cursor', 'limit', 'preset']),
      );
    });

    it('documents the discovery routes', async () => {
      const document = (await app.inject({ method: 'GET', url: '/docs/json' })).json<{
        paths: Record<string, unknown>;
      }>();
      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/v1/info',
          '/v1/search',
          '/v1/transcripts',
          '/v1/comments',
          '/v1/presets',
        ]),
      );
    });
  });

  describe('with SITE_ALLOWLIST=vimeo', () => {
    it('disables search elsewhere and lists no search sites', async () => {
      const restricted = await build({ SITE_ALLOWLIST: 'vimeo' });
      try {
        const search = await restricted.inject({
          method: 'GET',
          url: '/v1/search?q=x',
          headers: auth,
        });
        expect(search.statusCode).toBe(501);
        expect(search.json<ErrorBody>().error.code).toBe('FEATURE_DISABLED');
        const presets = await restricted.inject({
          method: 'GET',
          url: '/v1/presets',
          headers: auth,
        });
        expect(presets.json<{ search_sites: string[] }>().search_sites).toEqual([]);
      } finally {
        await restricted.close();
      }
    });
  });

  describe('as the user, with their cookies and site login (SPEC §7f)', () => {
    const as = (user: string) => ({ ...auth, 'x-user-id': user });
    const asAda = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: as('ada'), payload });
    let jarId: string;

    beforeAll(async () => {
      const saved = await app.inject({
        method: 'PUT',
        url: '/v1/cookies',
        headers: as('ada'),
        payload: { cookies: jar('ada-sid') },
      });
      expect(saved.statusCode).toBe(200);
      jarId = saved.json<{ id: string }>().id;
    });

    beforeEach(() => {
      rmSync(CALLS_LOG, { force: true });
    });

    it('looks members-only media up with the jar, then shreds the jar', async () => {
      const refused = await asAda('/v1/info', { url: 'https://fake.test/members' });
      expect(refused.json<ErrorBody>().error.code).toBe('LOGIN_REQUIRED');
      expect(lastAccess('members')?.sid).toBeNull();

      const response = await asAda('/v1/info', {
        url: 'https://fake.test/members',
        cookies: jarId,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ type: 'video', title: 'members' });
      const run = lastAccess('members');
      expect(run?.sid).toBe('ada-sid');
      expect(run?.cookieFile).toEqual(expect.any(String));
      expect(existsSync(run?.cookieFile ?? '')).toBe(false);
    });

    it('takes true for the default jar', async () => {
      const response = await asAda('/v1/info', { url: 'https://fake.test/members', cookies: true });
      expect(response.statusCode).toBe(200);
      expect(lastAccess('members')?.sid).toBe('ada-sid');
    });

    it('passes the jar to transcripts and comments', async () => {
      const transcript = await asAda('/v1/transcripts', {
        url: 'https://fake.test/members',
        cookies: jarId,
      });
      // Past the members check: the fake has no subtitles for this video.
      expect(transcript.json<ErrorBody>().error.code).toBe('NOT_FOUND');
      expect(lastAccess('members')?.sid).toBe('ada-sid');

      const comments = await asAda('/v1/comments', {
        url: 'https://fake.test/members',
        cookies: jarId,
        max: 5,
      });
      expect(comments.statusCode).toBe(200);
      expect(lastAccess('members')?.sid).toBe('ada-sid');
    });

    it('passes the jar to search, by id or as true', async () => {
      const search = (query: string) =>
        app.inject({ method: 'GET', url: `/v1/search?q=zoo${query}`, headers: as('ada') });
      expect((await search(`&cookies=${jarId}`)).statusCode).toBe(200);
      expect(lastAccess('search')?.sid).toBe('ada-sid');
      expect((await search('&cookies=true')).statusCode).toBe(200);
      expect(lastAccess('search')?.sid).toBe('ada-sid');
      expect((await search('')).statusCode).toBe(200);
      expect(lastAccess('search')?.sid).toBeNull();
    });

    it("never uses another user's jar", async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/info',
        headers: as('bob'),
        payload: { url: 'https://fake.test/members', cookies: jarId },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.message).toMatch(/no such cookie jar/);
      expect(lastAccess('members')).toBeUndefined();
    });

    it('needs an end user for cookies, and takes only true or a jar id', async () => {
      const anonymous = await post('/v1/info', { url: 'https://fake.test/members', cookies: true });
      expect(anonymous.statusCode).toBe(400);
      expect(anonymous.json<ErrorBody>().error.message).toMatch(/end-user id/);
      const named = await asAda('/v1/info', { url: 'https://fake.test/video', cookies: 'jar.txt' });
      expect(named.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
      const searched = await app.inject({
        method: 'GET',
        url: '/v1/search?q=zoo&cookies=yes',
        headers: as('ada'),
      });
      expect(searched.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
    });

    it('signs in with the site login', async () => {
      const withLogins = await build({ SITE_CREDENTIALS_ENABLED: 'true' });
      try {
        const saved = await withLogins.inject({
          method: 'PUT',
          url: '/v1/credentials/fake',
          headers: as('ada'),
          payload: { username: 'ada@example.com', password: 'hunter2', totp_seed: SEED },
        });
        expect(saved.statusCode).toBe(200);
        const response = await withLogins.inject({
          method: 'POST',
          url: '/v1/info',
          headers: as('ada'),
          payload: { url: 'https://fake.test/login', credentials: 'fake' },
        });
        expect(response.statusCode).toBe(200);
        expect(lastAccess('login')).toMatchObject({ username: 'ada@example.com' });
        expect(lastAccess('login')?.twofactor).toMatch(/^\d{6}$/);
      } finally {
        await withLogins.close();
      }
    });
  });
});
