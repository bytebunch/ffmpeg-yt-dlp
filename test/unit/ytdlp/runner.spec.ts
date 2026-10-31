import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { minimalEnv, type RunnerSettings, YtDlpRunner } from '../../../src/ytdlp/runner';

const FAKE = path.resolve(__dirname, '../../fixtures/bin/fake-yt-dlp');

const settings: RunnerSettings = {
  bin: FAKE,
  denoBin: '/usr/local/bin/deno',
  cacheDir: '/tmp/ytdlp-cache',
  extractors: [],
  impersonate: 'chrome',
  sleepRequestsSeconds: 0,
};

interface Echo {
  _fake: { args: string[]; env: Record<string, string>; cwd: string };
}

const runner = (overrides: Partial<RunnerSettings> = {}) =>
  new YtDlpRunner({ ...settings, ...overrides });
const echo = async (overrides: Partial<RunnerSettings> = {}) =>
  (
    (await runner(overrides).json(['--flat-playlist'], 'https://fake.test/echo', {
      timeoutMs: 10_000,
    })) as Echo
  )._fake;

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('YtDlpRunner', () => {
  it('puts the fixed flags first, then the call arguments, -J, -- and the URL last', async () => {
    const { args } = await echo();
    expect(args).toEqual([
      '--ignore-config',
      '--no-colors',
      '--socket-timeout',
      '30',
      '--use-extractors',
      'default,-generic',
      '--js-runtimes',
      'deno:/usr/local/bin/deno',
      '--cache-dir',
      '/tmp/ytdlp-cache',
      '--impersonate',
      'chrome',
      '--flat-playlist',
      '-J',
      '--',
      'https://fake.test/echo',
    ]);
  });

  it('restricts extractors to SITE_ALLOWLIST and honours impersonation and sleep settings', async () => {
    const { args } = await echo({
      extractors: ['youtube', 'vimeo'],
      impersonate: 'none',
      sleepRequestsSeconds: 1.5,
    });
    expect(args.slice(4, 6)).toEqual(['--use-extractors', 'youtube,vimeo']);
    expect(args).not.toContain('--impersonate');
    expect(args).toContain('--sleep-requests');
    expect(args[args.indexOf('--sleep-requests') + 1]).toBe('1.5');
  });

  it('points the PO-token plugin at YTDLP_POT_PROVIDER_URL', async () => {
    const { args } = await echo({ potProviderUrl: 'http://pot-provider:4416' });
    expect(args[args.indexOf('--extractor-args') + 1]).toBe(
      'youtubepot-bgutilhttp:base_url=http://pot-provider:4416',
    );
    expect((await echo()).args).not.toContain('--extractor-args');
  });

  it('passes only the minimal environment, so service secrets never reach yt-dlp', async () => {
    process.env.DATABASE_URL = 'postgres://secret';
    process.env.LINK_SIGNING_SECRET = 'secret';
    try {
      const { env, cwd } = await echo();
      expect(Object.keys(env).sort()).toEqual([
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'PYTHONDONTWRITEBYTECODE',
        'TMPDIR',
      ]);
      expect(env.HOME).toBe(cwd);
      expect(env.TMPDIR).toBe(cwd);
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.LINK_SIGNING_SECRET;
    }
  });

  it('runs in a throwaway directory that is removed afterwards', async () => {
    const { cwd } = await echo();
    expect(cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it('keeps a caller-provided work directory', async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'keep-'));
    const { stdout } = await runner().run([], 'https://fake.test/echo', {
      timeoutMs: 10_000,
      workDir,
    });
    expect((JSON.parse(stdout) as Echo)._fake.cwd).toBe(workDir);
    expect(existsSync(workDir)).toBe(true);
  });

  it('decodes UTF-8 output', async () => {
    const result = (await runner().json([], 'https://fake.test/echo', { timeoutMs: 10_000 })) as {
      title: string;
    };
    expect(result.title).toBe('Ünïcödé ✓');
  });

  it('classifies yt-dlp errors', async () => {
    const error = await failure(
      runner().json([], 'https://fake.test/private', { timeoutMs: 10_000 }),
    );
    expect(error.code).toBe('MEDIA_PRIVATE');
    expect(error.message).toMatch(/^Private video/);
  });

  it('reports crashes without an ERROR line as extraction failures', async () => {
    expect(
      (await failure(runner().json([], 'https://fake.test/crash', { timeoutMs: 10_000 }))).code,
    ).toBe('EXTRACTION_FAILED');
  });

  it('kills a run that exceeds its timeout', async () => {
    const started = Date.now();
    const error = await failure(runner().json([], 'https://fake.test/slow', { timeoutMs: 500 }));
    expect(error.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it('stops a run when the caller cancels it', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 200);
    const error = await failure(
      runner().json([], 'https://fake.test/slow', { timeoutMs: 30_000, signal: controller.signal }),
    );
    expect(error).toMatchObject({ code: 'TIMEOUT', message: 'The request was cancelled' });
  });

  it('caps the output size', async () => {
    const error = await failure(
      runner().json([], 'https://fake.test/huge', { timeoutMs: 10_000, maxOutputBytes: 1000 }),
    );
    expect(error.code).toBe('EXTRACTION_FAILED');
  });

  it('rejects output that is not JSON', async () => {
    const error = await failure(
      runner().json([], 'https://fake.test/garbage', { timeoutMs: 10_000 }),
    );
    expect(error.message).toMatch(/not JSON/);
  });

  it('treats a missing binary as a server fault, not a caller error', async () => {
    await expect(runner({ bin: '/nonexistent/yt-dlp' }).version()).rejects.toThrow(
      /could not be started/,
    );
    await expect(runner({ bin: '/nonexistent/yt-dlp' }).version()).rejects.not.toBeInstanceOf(
      AppError,
    );
  });

  it('reads the version', async () => {
    expect(await runner().version()).toBe('2099.01.01');
  });
});

describe('minimalEnv', () => {
  it('points HOME and TMPDIR at the work directory', () => {
    expect(minimalEnv('/tmp/w')).toMatchObject({
      HOME: '/tmp/w',
      TMPDIR: '/tmp/w',
      LC_ALL: 'C.UTF-8',
    });
  });
});

describe('YtDlpRunner streaming', () => {
  it('hands every stdout line to onStdoutLine while still collecting stdout', async () => {
    const lines: string[] = [];
    const { stdout } = await new YtDlpRunner(settings).run([], 'https://fake.test/echo', {
      timeoutMs: 10_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual([stdout]);
  });

  it('lets a run override the default impersonation target', async () => {
    const { args } = (
      (await new YtDlpRunner(settings).json([], 'https://fake.test/echo', {
        timeoutMs: 10_000,
        impersonate: 'safari',
      })) as Echo
    )._fake;
    expect(args[args.indexOf('--impersonate') + 1]).toBe('safari');
  });
});
