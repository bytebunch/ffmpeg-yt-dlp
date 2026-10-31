import { createReadStream, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { downloadArgs } from '../../../src/downloads/args';
import { classifyFile } from '../../../src/downloads/classify';
import { downloadOptionsSchema } from '../../../src/downloads/options';
import { parseProgressLine, type Progress } from '../../../src/downloads/progress';
import { YtDlpRunner } from '../../../src/ytdlp/runner';

/**
 * The real yt-dlp must accept every flag the builder emits and print the progress format the
 * worker parses. The generic extractor is enabled here only to reach a local file.
 */
describe('real yt-dlp download with the builder arguments', () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'real-download-'));
    await execa('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-shortest',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      path.join(dir, 'clip.mp4'),
    ]);
    // Range support matters: section downloads let ffmpeg seek inside the remote file.
    server = createServer((request, response) => {
      if (request.url !== '/clip.mp4') {
        response.writeHead(404).end();
        return;
      }
      const file = path.join(dir, 'clip.mp4');
      const size = statSync(file).size;
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      response.writeHead(match ? 206 : 200, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(match ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file, { start, end }).pipe(response);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  async function download(input: Record<string, unknown>) {
    const workDir = path.join(dir, `work-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(workDir, '.tmp'), { recursive: true });
    const options = downloadOptionsSchema.parse(input);
    const progress: Progress[] = [];
    const runner = new YtDlpRunner({
      bin: 'yt-dlp',
      denoBin: 'deno',
      cacheDir: path.join(dir, 'cache'),
      extractors: ['generic'],
      impersonate: 'none',
      sleepRequestsSeconds: 0,
    });
    await runner.run(
      downloadArgs(options, {
        workDir,
        tempDir: path.join(workDir, '.tmp'),
        ffmpegLocation: (await execa('sh', ['-c', 'command -v ffmpeg'])).stdout,
        maxFileSizeMb: 100,
        sponsorblockApiUrl: 'https://sponsor.ajay.app',
      }),
      `${base}/clip.mp4`,
      {
        timeoutMs: 120_000,
        workDir,
        onStdoutLine: (line) => {
          const parsed = parseProgressLine(line);
          if (parsed) progress.push(parsed);
        },
      },
    );
    const files = readdirSync(workDir).filter((name) => classifyFile(name) !== undefined);
    return { files, progress, workDir };
  }

  it('downloads with defaults, reporting progress up to 100%', async () => {
    const { files, progress } = await download({});
    expect(files).toEqual([expect.stringMatching(/^clip \[clip\]\.mp4$/)]);
    expect(progress.some((entry) => entry.stage === 'downloading')).toBe(true);
    expect(progress.filter((entry) => entry.stage === 'downloading').at(-1)?.percent).toBe(100);
  });

  it('accepts a kitchen-sink option set', async () => {
    const { files, progress } = await download({
      preset: '720p',
      container: 'mkv',
      video_codec: 'h264',
      audio_codec: 'aac',
      fps_max: 30,
      hdr: 'avoid',
      format_sort: ['+size', 'proto'],
      max_filesize_mb: 50,
      sections: [{ start: 0, end: 2 }],
      force_keyframes: true,
      chapters: { embed: true, remove_titles: ['Outro'] },
      sponsorblock: { mark: ['sponsor'], chapter_title: 'category' },
      subtitles: { langs: ['en'], format: 'srt' },
      thumbnail: { write: true, convert: 'jpg' },
      metadata: { embed: true },
      extras: ['info_json', 'description'],
      filename: 'date_title',
      ascii_filenames: true,
      windows_safe: true,
      limit_rate_kbps: 100_000,
      concurrent_fragments: 2,
    });
    expect(files.some((name) => name.endsWith('.mkv'))).toBe(true);
    expect(files.some((name) => name.endsWith('.info.json'))).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('removes time ranges when SponsorBlock is not involved', async () => {
    const { files } = await download({
      chapters: { remove_ranges: [{ start: '0:02', end: '0:02.5' }] },
      filename: 'id',
    });
    expect(files).toEqual(['clip.mp4']);
  });

  it('still crashes on remove_ranges + SponsorBlock (yt-dlp bug); when this fails, lift the rule in options.ts', async () => {
    const result = await execa(
      'yt-dlp',
      [
        '--ignore-config',
        '--use-extractors',
        'generic',
        '--remove-chapters',
        '*2-2.5',
        '--sponsorblock-mark',
        'sponsor',
        '--simulate',
        '--',
        `${base}/clip.mp4`,
      ],
      { reject: false },
    );
    expect(result.stderr).toContain("TypeError: unhashable type: 'list'");
  });

  it('extracts audio with an audio preset and keeps the source on request', async () => {
    const { files } = await download({
      preset: 'audio_mp3',
      audio_bitrate_kbps: 128,
      keep_video: true,
      filename: 'id',
    });
    expect(files.sort()).toEqual(['clip.mp3', 'clip.mp4']);
  });

  it('writes metadata only for metadata_only', async () => {
    const { files } = await download({ preset: 'metadata_only', filename: 'id' });
    expect(files).toEqual(['clip.info.json']);
  });
});
