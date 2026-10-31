import { createReadStream, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { type RunnerSettings, YtDlpRunner } from '../../../src/ytdlp/runner';

/**
 * The real yt-dlp binary against a local web server. The production policy disables the
 * generic extractor; these tests enable it explicitly to reach a local file.
 */
describe('real yt-dlp', () => {
  let dir: string;
  let server: Server;
  let base: string;

  const settings = (overrides: Partial<RunnerSettings> = {}): RunnerSettings => ({
    bin: 'yt-dlp',
    denoBin: 'deno',
    cacheDir: path.join(dir, 'cache'),
    extractors: ['generic'],
    impersonate: 'none',
    sleepRequestsSeconds: 0,
    ...overrides,
  });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'real-ytdlp-'));
    await execa('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-shortest',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      path.join(dir, 'clip.mp4'),
    ]);
    server = createServer((request, response) => {
      if (request.url !== '/clip.mp4') {
        response.writeHead(404).end('not found');
        return;
      }
      const file = path.join(dir, 'clip.mp4');
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(statSync(file).size),
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(file).pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('reports a dated version', async () => {
    expect(await new YtDlpRunner(settings()).version()).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
  });

  it('extracts metadata as JSON through the minimal environment', async () => {
    const info = (await new YtDlpRunner(settings()).json([], `${base}/clip.mp4`, {
      timeoutMs: 60_000,
    })) as { extractor: string; title: string; ext: string; formats: unknown[] };
    expect(info).toMatchObject({ extractor: 'generic', title: 'clip', ext: 'mp4' });
    expect(info.formats.length).toBeGreaterThan(0);
  });

  it('works with browser impersonation (curl_cffi installed)', async () => {
    const info = (await new YtDlpRunner(settings({ impersonate: 'chrome' })).json(
      [],
      `${base}/clip.mp4`,
      {
        timeoutMs: 60_000,
      },
    )) as { title: string };
    expect(info.title).toBe('clip');
  });

  it('classifies a 404 as MEDIA_UNAVAILABLE', async () => {
    await expect(
      new YtDlpRunner(settings()).json([], `${base}/missing.mp4`, { timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
  });

  it('refuses plain media URLs under the production policy (generic extractor disabled)', async () => {
    const error: unknown = await new YtDlpRunner(settings({ extractors: [] }))
      .json([], `${base}/clip.mp4`, { timeoutMs: 60_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNSUPPORTED_SITE');
  });
});
