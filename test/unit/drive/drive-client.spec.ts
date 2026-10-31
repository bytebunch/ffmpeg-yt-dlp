import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import type { MockInterceptor } from 'undici/types/mock-interceptor';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DriveClient, FOLDER_MIME } from '../../../src/drive/drive-client';

/** Drive v3 calls (SPEC §11) against undici's MockAgent. */

const ORIGIN = 'https://www.googleapis.com';
const SESSION = '/upload/drive/v3/files?uploadType=resumable&upload_id=session-1';
const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };
type Request = MockInterceptor.MockResponseCallbackOptions;
/** A request body as text (MockAgent hands over strings or bytes). */
const bodyText = (body: Request['body']) =>
  typeof body === 'string' ? body : body ? Buffer.from(body as Uint8Array).toString() : '';
/** MockAgent sorts query parameters before matching, so match on the pathname and a parameter. */
const at = (pathname: string, param?: string) => (requested: string) => {
  const url = new URL(requested, ORIGIN);
  return url.pathname === pathname && (param === undefined || url.searchParams.has(param));
};
const dir = mkdtempSync(path.join(tmpdir(), 'drive-'));
const FILE = path.join(dir, 'clip.bin');
const CONTENT = Buffer.from('abcdefghijklmnopqrstuvwxy'); // 25 bytes
writeFileSync(FILE, CONTENT);

describe('DriveClient', () => {
  let mock: MockAgent;
  let original: Dispatcher;
  let token: ReturnType<typeof vi.fn<(refresh?: boolean) => Promise<string>>>;
  let client: DriveClient;
  const google = () => mock.get(ORIGIN);

  /** The resumable session start; the session URI comes back in Location. */
  const startSession = () =>
    google()
      .intercept({
        path: at('/upload/drive/v3/files', 'fields'),
        method: 'POST',
      })
      .reply(200, '', { headers: { location: `${ORIGIN}${SESSION}` } });

  beforeAll(() => {
    original = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
  });

  beforeEach(() => {
    token = vi.fn((refresh?: boolean) => Promise.resolve(refresh ? 'fresh-token' : 'token'));
    client = new DriveClient({ token, sleep: () => Promise.resolve(), chunkBytes: 10 });
  });

  afterEach(() => {
    mock.assertNoPendingInterceptors();
  });

  afterAll(async () => {
    setGlobalDispatcher(original);
    await mock.close();
  });

  it('creates folders and checks that a target is a folder this service can see', async () => {
    let created: unknown;
    google()
      .intercept({ path: at('/drive/v3/files', 'fields'), method: 'POST' })
      .reply((request) => {
        created = JSON.parse(bodyText(request.body));
        return {
          statusCode: 200,
          data: { id: 'f1', name: 'Media downloads', mimeType: FOLDER_MIME },
          ...JSON_HEADERS,
        };
      });
    expect(await client.createFolder('Media downloads', 'root-x')).toMatchObject({ id: 'f1' });
    expect(created).toEqual({
      name: 'Media downloads',
      mimeType: FOLDER_MIME,
      parents: ['root-x'],
    });

    google()
      .intercept({ path: at('/drive/v3/files/f1'), method: 'GET' })
      .reply(200, { id: 'f1', name: 'x', mimeType: FOLDER_MIME }, JSON_HEADERS);
    expect((await client.folder('f1')).id).toBe('f1');
    google()
      .intercept({ path: at('/drive/v3/files/hand-made'), method: 'GET' })
      .reply(404, { error: { code: 404, message: 'File not found' } }, JSON_HEADERS);
    await expect(client.folder('hand-made')).rejects.toMatchObject({
      code: 'DRIVE_FOLDER_NOT_ACCESSIBLE',
    });
    google()
      .intercept({ path: at('/drive/v3/files/doc'), method: 'GET' })
      .reply(200, { id: 'doc', name: 'a.mp4', mimeType: 'video/mp4' }, JSON_HEADERS);
    await expect(client.folder('doc')).rejects.toMatchObject({
      code: 'DRIVE_FOLDER_NOT_ACCESSIBLE',
    });
    google()
      .intercept({ path: at('/drive/v3/files/bin'), method: 'GET' })
      .reply(200, { id: 'bin', name: 'x', mimeType: FOLDER_MIME, trashed: true }, JSON_HEADERS);
    await expect(client.folder('bin')).rejects.toMatchObject({
      code: 'DRIVE_FOLDER_NOT_ACCESSIBLE',
    });
  });

  it('lists the files this service created, page by page', async () => {
    let query: URLSearchParams | undefined;
    google()
      .intercept({ path: at('/drive/v3/files', 'q'), method: 'GET' })
      .reply((request) => {
        query = new URL(request.path, ORIGIN).searchParams;
        return {
          statusCode: 200,
          data: {
            files: [{ id: 'a', name: 'a.mp4', mimeType: 'video/mp4' }],
            nextPageToken: 'next',
          },
          ...JSON_HEADERS,
        };
      });
    expect(await client.list('page-2', 50)).toEqual({
      files: [{ id: 'a', name: 'a.mp4', mimeType: 'video/mp4' }],
      nextPageToken: 'next',
    });
    expect(Object.fromEntries(query ?? [])).toMatchObject({
      q: 'trashed = false',
      pageSize: '50',
      pageToken: 'page-2',
      orderBy: 'createdTime desc',
    });
  });

  it('uploads in chunks and resumes from the offset Drive confirms after a failed chunk', async () => {
    let started: { body: unknown; headers: Record<string, string> } | undefined;
    google()
      .intercept({
        path: at('/upload/drive/v3/files', 'fields'),
        method: 'POST',
      })
      .reply((request) => {
        started = {
          body: JSON.parse(bodyText(request.body)),
          headers: (request.headers ?? {}) as Record<string, string>,
        };
        return {
          statusCode: 200,
          data: '',
          responseOptions: { headers: { location: `${ORIGIN}${SESSION}` } },
        };
      });
    const puts: { range: string; body: string }[] = [];
    const answer =
      (status: number, extra: object = {}) =>
      (request: Request) => {
        const headers = (request.headers ?? {}) as Record<string, string>;
        puts.push({ range: headers['content-range'] ?? '', body: bodyText(request.body) });
        return { statusCode: status, data: '', ...extra };
      };
    const session = google();
    session
      .intercept({ path: SESSION, method: 'PUT' })
      .reply(answer(308, { responseOptions: { headers: { range: 'bytes=0-9' } } }));
    // The second chunk fails, but Drive did store it: the status query says so.
    session.intercept({ path: SESSION, method: 'PUT' }).reply(answer(503));
    session
      .intercept({ path: SESSION, method: 'PUT' })
      .reply(answer(308, { responseOptions: { headers: { range: 'bytes=0-19' } } }));
    session.intercept({ path: SESSION, method: 'PUT' }).reply((request) => {
      answer(200)(request);
      return {
        statusCode: 200,
        data: {
          id: 'file-1',
          name: 'clip.bin',
          mimeType: 'video/mp4',
          webViewLink: 'https://drive.google.com/file/d/file-1/view',
        },
        ...JSON_HEADERS,
      };
    });
    const file = await client.upload(FILE, {
      name: 'clip.bin',
      mime: 'video/mp4',
      parentId: 'folder-1',
      size: CONTENT.length,
    });
    expect(file).toMatchObject({
      id: 'file-1',
      webViewLink: 'https://drive.google.com/file/d/file-1/view',
    });
    expect(started?.body).toEqual({ name: 'clip.bin', parents: ['folder-1'] });
    expect(started?.headers).toMatchObject({
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': '25',
    });
    expect(puts).toEqual([
      { range: 'bytes 0-9/25', body: 'abcdefghij' },
      { range: 'bytes 10-19/25', body: 'klmnopqrst' },
      { range: 'bytes */25', body: '' },
      { range: 'bytes 20-24/25', body: 'uvwxy' },
    ]);
  });

  it('refreshes the token once on 401', async () => {
    google()
      .intercept({ path: at('/drive/v3/files/f2'), method: 'GET' })
      .reply(401, { error: { code: 401 } }, JSON_HEADERS);
    google()
      .intercept({
        path: at('/drive/v3/files/f2'),
        method: 'GET',
        headers: { authorization: 'Bearer fresh-token' },
      })
      .reply(200, { id: 'f2', name: 'x', mimeType: FOLDER_MIME }, JSON_HEADERS);
    expect((await client.folder('f2')).id).toBe('f2');
    expect(token).toHaveBeenLastCalledWith(true);
  });

  it('maps a full Drive, and keeps retrying rate limits and network errors with backoff', async () => {
    google()
      .intercept({ path: at('/upload/drive/v3/files'), method: 'POST' })
      .reply(
        403,
        {
          error: {
            code: 403,
            message: 'The user’s Drive storage quota has been exceeded.',
            errors: [{ reason: 'storageQuotaExceeded' }],
          },
        },
        JSON_HEADERS,
      );
    await expect(
      client.upload(FILE, { name: 'a', mime: 'video/mp4', parentId: 'p', size: 25 }),
    ).rejects.toMatchObject({ code: 'DRIVE_STORAGE_FULL' });

    const sleeps: number[] = [];
    const patient = new DriveClient({
      token,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      chunkBytes: 10,
    });
    google()
      .intercept({ path: at('/drive/v3/files/f3'), method: 'GET' })
      .reply(
        403,
        { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
        JSON_HEADERS,
      );
    google()
      .intercept({ path: at('/drive/v3/files/f3'), method: 'GET' })
      .reply(429, { error: { code: 429 } }, JSON_HEADERS);
    google()
      .intercept({ path: at('/drive/v3/files/f3'), method: 'GET' })
      .replyWithError(new Error('socket hang up'));
    google()
      .intercept({ path: at('/drive/v3/files/f3'), method: 'GET' })
      .reply(200, { id: 'f3', name: 'x', mimeType: FOLDER_MIME }, JSON_HEADERS);
    expect((await patient.folder('f3')).id).toBe('f3');
    expect(sleeps.map((ms) => Math.floor(ms / 1000))).toEqual([1, 2, 4]);

    for (let i = 0; i < 6; i++)
      google()
        .intercept({ path: at('/drive/v3/files/f4'), method: 'GET' })
        .reply(503, '');
    await expect(patient.folder('f4')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringMatching(/kept failing/) as string,
    });
  });

  it('finishes empty files with a single status request', async () => {
    startSession();
    google()
      .intercept({ path: SESSION, method: 'PUT', headers: { 'content-range': 'bytes */0' } })
      .reply(200, { id: 'empty', name: 'e', mimeType: 'text/plain' }, JSON_HEADERS);
    expect(
      (await client.upload(FILE, { name: 'e', mime: 'text/plain', parentId: 'p', size: 0 })).id,
    ).toBe('empty');
  });
});
