import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView } from '../../../src/jobs/jobs.service';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { ensureFakeMedia, fakeCalls, type JobStack, startJobStack } from '../support/jobs';

interface ErrorBody {
  error: { code: string; message: string };
}
interface UploadCreated {
  uploadId: string;
  tusUrl: string;
  uploadToken: string;
  status: string;
}

const CLIP = '/tmp/fake-media/clip.mp4';

describe('inputs: uploads (tus), inbox, outputs, URLs, probe (Postgres + Redis)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  let inboxDir: string;
  let server: Server;
  let base: string;
  const requests: string[] = [];
  const auth: Record<string, string> = {};

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const { key } = await new ApiKeyService(createDatabase(pool)).create({ clientName: 'inputs' });
    Object.assign(auth, { authorization: `Bearer ${key}`, 'x-user-id': 'alice' });
    inboxDir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    mkdirSync(path.join(inboxDir, 'inputs'));
    writeFileSync(path.join(inboxDir, 'inputs', 'clip.mp4'), readFileSync(CLIP));
    writeFileSync(path.join(inboxDir, 'secret.txt'), 'outside the client folder');
    symlinkSync(path.join(inboxDir, 'secret.txt'), path.join(inboxDir, 'inputs', 'link.mp4'));

    // "localhost" passes the stubbed public DNS check but connects to this local server.
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      const url = request.url ?? '';
      const redirect = /^\/hop\/(\d+)$/.exec(url);
      if (redirect) {
        const n = Number(redirect[1]);
        response.writeHead(302, { location: n === 0 ? '/clip.mp4' : `/hop/${n - 1}` }).end();
      } else if (url === '/to-private') {
        response.writeHead(302, { location: 'http://127.0.0.1:1/clip.mp4' }).end();
      } else if (url === '/clip.mp4' || url === '/big.mp4') {
        const body =
          url === '/big.mp4'
            ? Buffer.concat([readFileSync(CLIP), Buffer.alloc(2 * 1024 * 1024)])
            : readFileSync(CLIP);
        response
          .writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) })
          .end(body);
      } else if (url === '/page.html') {
        response.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
      } else if (url === '/playlist.m3u8') {
        response
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end(
            `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://localhost:${(server.address() as AddressInfo).port}/segment.ts\n#EXT-X-ENDLIST\n`,
          );
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        INBOX_DIR: inboxDir,
        PROBE_MAX_MB: '1',
      },
      auth,
    );
  });

  afterAll(async () => {
    await stack.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const api = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    stack.app.inject({
      method,
      url,
      headers: { ...auth, ...headers },
      ...(payload ? { payload } : {}),
    });
  const probe = (input: object) => api('POST', '/v1/probe', { input });
  /** tus over real HTTP: the upload body must stream through a socket like in production. */
  let apiUrl: string | undefined;
  const tus = async (
    method: 'HEAD' | 'PATCH' | 'OPTIONS' | 'POST' | 'GET',
    id: string,
    token: string | undefined,
    body?: Buffer,
    offset?: number,
  ) => {
    if (apiUrl === undefined) {
      await stack.app.listen({ port: 0, host: '127.0.0.1' });
      apiUrl = await stack.app.getUrl();
    }
    const response = await fetch(`${apiUrl}/u/${id}`, {
      method,
      headers: {
        'tus-resumable': '1.0.0',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(offset === undefined
          ? {}
          : { 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }),
      },
      ...(body ? { body } : {}),
    });
    await response.arrayBuffer();
    return { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()) };
  };

  describe('resumable uploads', () => {
    let clip: Buffer;
    let created: UploadCreated;

    beforeAll(async () => {
      clip = readFileSync(CLIP);
      const response = await api('POST', '/v1/uploads', {
        filename: '../evil/clip.mp4',
        size: clip.length,
        mime: 'video/mp4',
      });
      expect(response.statusCode, response.body).toBe(201);
      created = response.json<UploadCreated>();
    });

    it('creates an upload with a tus URL and a token', () => {
      expect(created).toMatchObject({
        status: 'uploading',
        tusUrl: `http://localhost:3000/u/${created.uploadId}`,
      });
      expect(created.uploadToken).toMatch(/^\d+\.[\w-]{43}$/);
    });

    it('strips directories from the file name', async () => {
      expect(
        (await api('GET', `/v1/uploads/${created.uploadId}`)).json<{ filename: string }>().filename,
      ).toBe('clip.mp4');
    });

    it('refuses tus requests without a valid token, and creation through /u', async () => {
      expect((await tus('HEAD', created.uploadId, undefined)).statusCode).toBe(401);
      expect((await tus('HEAD', created.uploadId, `9999999999.${'A'.repeat(43)}`)).statusCode).toBe(
        401,
      );
      expect((await tus('POST', created.uploadId, created.uploadToken)).statusCode).toBe(405);
      expect((await tus('GET', created.uploadId, created.uploadToken)).statusCode).toBe(405);
    });

    it('accepts chunks, can be resumed, and probes the finished file', async () => {
      const head = await tus('HEAD', created.uploadId, created.uploadToken);
      expect(head.headers['upload-offset']).toBe('0');
      expect(head.headers['upload-length']).toBe(String(clip.length));
      const half = Math.floor(clip.length / 2);
      const first = await tus(
        'PATCH',
        created.uploadId,
        created.uploadToken,
        clip.subarray(0, half),
        0,
      );
      expect(first.statusCode).toBe(204);
      expect(first.headers['upload-offset']).toBe(String(half));
      // A new HEAD after an interruption tells the client where to continue.
      expect(
        (await tus('HEAD', created.uploadId, created.uploadToken)).headers['upload-offset'],
      ).toBe(String(half));
      expect((await api('GET', `/v1/uploads/${created.uploadId}`)).json()).toMatchObject({
        status: 'uploading',
        received_size: half,
      });
      const rest = await tus(
        'PATCH',
        created.uploadId,
        created.uploadToken,
        clip.subarray(half),
        half,
      );
      expect(rest.statusCode).toBe(204);
      const state = (await api('GET', `/v1/uploads/${created.uploadId}`)).json<{
        status: string;
        probe: { format: string };
      }>();
      expect(state.status).toBe('ready');
      expect(state.probe.format).toContain('mp4');
      expect(
        (await tus('PATCH', created.uploadId, created.uploadToken, Buffer.from('x'), clip.length))
          .statusCode,
      ).toBe(409);
    });

    it('probes a ready upload as an input', async () => {
      const response = await probe({ type: 'upload', uploadId: created.uploadId });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ input: { type: 'upload', size_bytes: clip.length } });
    });

    it('keeps uploads private to their user', async () => {
      expect(
        (await api('GET', `/v1/uploads/${created.uploadId}`, undefined, { 'x-user-id': 'bob' }))
          .statusCode,
      ).toBe(404);
      const response = await api(
        'POST',
        '/v1/probe',
        { input: { type: 'upload', uploadId: created.uploadId } },
        { 'x-user-id': 'bob' },
      );
      expect(response.json<ErrorBody>().error.code).toBe('INPUT_NOT_FOUND');
    });

    it('rejects uploads that are not media, and refuses unfinished ones as inputs', async () => {
      const text = Buffer.from('just some text, not media');
      const upload = (
        await api('POST', '/v1/uploads', { filename: 'notes.txt', size: text.length })
      ).json<UploadCreated>();
      expect(
        (await probe({ type: 'upload', uploadId: upload.uploadId })).json<ErrorBody>().error.code,
      ).toBe('UPLOAD_INCOMPLETE');
      await tus('PATCH', upload.uploadId, upload.uploadToken, text, 0);
      expect(
        (await api('GET', `/v1/uploads/${upload.uploadId}`)).json<{ status: string }>().status,
      ).toBe('rejected');
    });

    it('enforces the upload size limit and deletes uploads on request', async () => {
      expect(
        (await api('POST', '/v1/uploads', { filename: 'huge.mp4', size: 5 * 1024 ** 3 }))
          .statusCode,
      ).toBe(413);
      const upload = (
        await api('POST', '/v1/uploads', { filename: 'gone.mp4', size: 10 })
      ).json<UploadCreated>();
      expect((await api('DELETE', `/v1/uploads/${upload.uploadId}`)).statusCode).toBe(200);
      expect((await api('GET', `/v1/uploads/${upload.uploadId}`)).statusCode).toBe(404);
    });
  });

  describe('inbox', () => {
    it('lists only plain files in the client folder', async () => {
      const { files } = (await api('GET', '/v1/inbox')).json<{ files: { name: string }[] }>();
      expect(files.map((file) => file.name)).toEqual(['clip.mp4']);
    });

    it('probes an inbox file by bare name', async () => {
      expect((await probe({ type: 'inbox', name: 'clip.mp4' })).statusCode).toBe(200);
    });

    it.each([
      ['../secret.txt', 'VALIDATION_FAILED'],
      ['.hidden', 'VALIDATION_FAILED'],
      ['link.mp4', 'INPUT_NOT_FOUND'],
      ['missing.mp4', 'INPUT_NOT_FOUND'],
    ])('refuses %s', async (name, code) => {
      expect((await probe({ type: 'inbox', name })).json<ErrorBody>().error.code).toBe(code);
    });
  });

  describe('URL inputs', () => {
    it('fetches, probes and caches a URL', async () => {
      const before = requests.filter((url) => url === '/clip.mp4').length;
      expect((await probe({ type: 'url', url: `${base}/clip.mp4` })).statusCode).toBe(200);
      expect((await probe({ type: 'url', url: `${base}/clip.mp4` })).statusCode).toBe(200);
      expect(requests.filter((url) => url === '/clip.mp4').length).toBe(before + 1);
    });

    it('follows up to five redirects, checking every hop', async () => {
      expect((await probe({ type: 'url', url: `${base}/hop/4` })).statusCode).toBe(200);
      expect(
        (await probe({ type: 'url', url: `${base}/hop/6` })).json<ErrorBody>().error.code,
      ).toBe('URL_NOT_ALLOWED');
      expect(
        (await probe({ type: 'url', url: `${base}/to-private` })).json<ErrorBody>().error.code,
      ).toBe('URL_NOT_ALLOWED');
    });

    it('rejects non-media, missing and private URLs', async () => {
      expect(
        (await probe({ type: 'url', url: `${base}/page.html` })).json<ErrorBody>().error.code,
      ).toBe('INPUT_NOT_MEDIA');
      expect(
        (await probe({ type: 'url', url: `${base}/nothing` })).json<ErrorBody>().error.code,
      ).toBe('INPUT_NOT_FOUND');
      expect(
        (await probe({ type: 'url', url: 'http://10.0.0.1/x.mp4' })).json<ErrorBody>().error.code,
      ).toBe('URL_NOT_ALLOWED');
    });

    it('never lets ffprobe follow URLs inside a fetched playlist', async () => {
      const response = await probe({ type: 'url', url: `${base}/playlist.m3u8` });
      expect(['INPUT_NOT_MEDIA', 'INPUT_FORMAT_NOT_ALLOWED']).toContain(
        response.json<ErrorBody>().error.code,
      );
      expect(requests).not.toContain('/segment.ts');
    });

    it('turns inputs above PROBE_MAX_MB into a probe job with a JSON report', async () => {
      const response = await probe({ type: 'url', url: `${base}/big.mp4` });
      expect(response.statusCode).toBe(202);
      const { job } = response.json<{ job: JobView }>();
      const done = await stack.waitFor(job.id);
      expect(done).toMatchObject({ type: 'probe', status: 'completed' });
      expect(done.outputs[0]).toMatchObject({
        role: 'report',
        name: 'probe.json',
        mime: 'application/json',
      });
      const report = JSON.parse(
        readFileSync(
          path.join(stack.filesDir, done.id, done.outputs[0]?.id ?? '', 'probe.json'),
          'utf8',
        ),
      ) as { input: { size_bytes: number } };
      expect(report.input.size_bytes).toBe(statSync(CLIP).size + 2 * 1024 * 1024);
    });

    it('refuses Drive inputs without a connection or API key', async () => {
      const drive = await probe({ type: 'google_drive', fileId: '1AbCdEfGhIjKlMnOp' });
      expect(drive.statusCode).toBe(409);
      expect(drive.json()).toMatchObject({ error: { code: 'DRIVE_NOT_CONNECTED' } });
    });
  });

  describe('media_url inputs (yt-dlp)', () => {
    it('downloads the video once, then serves recipes and probes from the cache', async () => {
      const before = fakeCalls('download jNQXAC9IVRw');
      const probed = await probe({ type: 'media_url', url: 'https://fake.test/video' });
      expect(probed.statusCode, probed.body).toBe(200);
      expect(probed.json()).toMatchObject({
        input: { type: 'media_url' },
        probe: { format: expect.stringContaining('mp4') as string },
      });
      const created = await stack.create({
        type: 'process',
        inputs: [{ type: 'media_url', url: 'https://fake.test/video' }],
        recipe: 'audio_mp3_192',
      });
      const done = await stack.waitFor(created.json<JobView>().id);
      expect(done).toMatchObject({ status: 'completed', outputs: [{ mime: 'audio/mpeg' }] });
      expect(fakeCalls('download jNQXAC9IVRw') - before).toBe(1);
    });

    it('refuses playlists, live streams, unsupported and private URLs', async () => {
      const code = async (url: string) =>
        (await probe({ type: 'media_url', url })).json<{ error: { code: string } }>().error.code;
      expect(await code('https://fake.test/playlist')).toBe('VALIDATION_FAILED');
      expect(await code('https://fake.test/live/now')).toBe('VALIDATION_FAILED');
      expect(await code('https://fake.test/unknown-page')).toBe('UNSUPPORTED_SITE');
      expect(await code('https://fake.test/private')).toBe('MEDIA_PRIVATE');
      expect(await code('http://127.0.0.1/admin')).toBe('URL_NOT_ALLOWED');
    });
  });

  describe('outputs as inputs', () => {
    it('reuses an output of an earlier job, extending its expiry, for its owner only', async () => {
      const created = await stack.create({
        type: 'download',
        url: 'https://fake.test/video',
        filename: 'id',
      });
      const job = await stack.waitFor(created.json<JobView>().id);
      const [output] = job.outputs;
      const before = output?.expires_at ?? '';
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await probe({ type: 'output', outputId: output?.id })).statusCode).toBe(200);
      const listed = (await api('GET', '/v1/outputs')).json<{
        outputs: { id: string; expires_at: string }[];
      }>();
      const after = listed.outputs.find((entry) => entry.id === output?.id)?.expires_at ?? '';
      expect(after > before).toBe(true);
      const other = await api(
        'POST',
        '/v1/probe',
        { input: { type: 'output', outputId: output?.id } },
        { 'x-user-id': 'bob' },
      );
      expect(other.json<ErrorBody>().error.code).toBe('INPUT_NOT_FOUND');
    });
  });
});
