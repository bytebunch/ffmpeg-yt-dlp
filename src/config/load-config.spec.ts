import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './load-config';

const key32 = () => randomBytes(32).toString('base64');

const required = {
  PUBLIC_BASE_URL: 'https://dl.example.com',
  DATABASE_URL: 'postgres://app:pw@db:5432/media',
  REDIS_URL: 'redis://redis:6379',
  LINK_SIGNING_SECRET: 'x'.repeat(44),
  TOKEN_ENCRYPTION_KEYS: `v1:${key32()}`,
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig({ ...required, ...env });
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies the SPEC §13 defaults and derived values to a minimal environment', () => {
    const config = loadConfig(required);
    expect(config.DOWNLOAD_CONCURRENCY).toBe(4);
    expect(config.API_RATE_LIMIT_PER_MINUTE).toBe(120);
    expect(config.RECIPE_TIMEOUT_FACTOR).toBe(2);
    expect(config.SPONSORBLOCK_API_URL).toBe('https://sponsor.ajay.app');
    expect(config.YTDLP_IMPERSONATE_DEFAULT).toBe('chrome');
    expect(config.BACKUP_ENABLED).toBe(true);
    expect(config.DATABASE_MIGRATION_URL).toBe(required.DATABASE_URL);
    expect(config.YTDLP_CACHE_DIR).toBe('/data/files/.cache/yt-dlp');
    expect(config.SITE_ALLOWLIST).toEqual([]);
    expect(config.FFMPEG_WHISPER_DEFAULT_MODEL).toBeUndefined();
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig(required))).toBe(true);
  });

  it('names every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (error) {
      expect((error as ConfigError).problems).toEqual(
        expect.arrayContaining([
          'PUBLIC_BASE_URL: is required',
          'DATABASE_URL: is required',
          'REDIS_URL: is required',
          'LINK_SIGNING_SECRET: is required',
          'TOKEN_ENCRYPTION_KEYS: is required',
        ]),
      );
    }
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ ...required, DOWNLOAD_CONCURRENCY: '', LOG_LEVEL: '' })).toMatchObject({
      DOWNLOAD_CONCURRENCY: 4,
      LOG_LEVEL: 'info',
    });
  });

  it('never echoes a rejected value, since many are secrets', () => {
    const hidden = 'zq9-hidden-value';
    const found = problems({ LINK_SIGNING_SECRET: hidden, DATABASE_URL: `mysql://${hidden}` });
    expect(found).toHaveLength(2);
    expect(found.join('\n')).not.toContain(hidden);
  });

  it('parses integers and rejects non-numbers and out-of-range values', () => {
    expect(loadConfig({ ...required, FFMPEG_THREADS: '8' }).FFMPEG_THREADS).toBe(8);
    expect(problems({ FFMPEG_THREADS: 'eight' })).toHaveLength(1);
    expect(problems({ DISK_QUOTA_PERCENT: '100' })[0]).toMatch(/^DISK_QUOTA_PERCENT:/);
    expect(problems({ API_PORT: '1.5' })[0]).toMatch(/^API_PORT:/);
  });

  it('parses booleans in their common spellings', () => {
    expect(loadConfig({ ...required, BACKUP_ENABLED: 'no' }).BACKUP_ENABLED).toBe(false);
    expect(
      loadConfig({ ...required, SITE_CREDENTIALS_ENABLED: '1' }).SITE_CREDENTIALS_ENABLED,
    ).toBe(true);
    expect(problems({ BACKUP_ENABLED: 'maybe' })[0]).toMatch(/^BACKUP_ENABLED:/);
  });

  it('takes PUBLIC_BASE_URL with or without a base path, never ending in a slash', () => {
    const base = (value: string) =>
      loadConfig({ ...required, PUBLIC_BASE_URL: value }).PUBLIC_BASE_URL;
    expect(base('https://dl.example.com/')).toBe('https://dl.example.com');
    expect(base('http://1.2.3.4:8080')).toBe('http://1.2.3.4:8080');
    // Behind a reverse proxy that serves the service under a path and strips it.
    expect(base('https://win.example.com/ffmpeg')).toBe('https://win.example.com/ffmpeg');
    expect(base('https://win.example.com/media/ffmpeg//')).toBe(
      'https://win.example.com/media/ffmpeg',
    );
    expect(base('https://win.example.com/my files')).toBe('https://win.example.com/my%20files');
    for (const value of [
      'https://dl.example.com/api?x=1',
      'https://dl.example.com/api#top',
      'https://user:pass@dl.example.com',
    ]) {
      expect(problems({ PUBLIC_BASE_URL: value })[0], value).toMatch(
        /^PUBLIC_BASE_URL: must be scheme:\/\/host\[:port\]\[\/path\]/,
      );
    }
    expect(problems({ PUBLIC_BASE_URL: 'ftp://dl.example.com' })[0]).toMatch(/^PUBLIC_BASE_URL:/);
  });

  it('requires postgres:// and redis:// connection URLs', () => {
    expect(problems({ DATABASE_URL: 'mysql://x' })[0]).toMatch(/^DATABASE_URL: must be a postgres/);
    expect(problems({ REDIS_URL: 'http://x' })[0]).toMatch(/^REDIS_URL:/);
    expect(loadConfig({ ...required, REDIS_URL: 'rediss://r:6380' }).REDIS_URL).toBe(
      'rediss://r:6380',
    );
  });

  it('decodes versioned encryption keys, newest first', () => {
    const config = loadConfig({
      ...required,
      TOKEN_ENCRYPTION_KEYS: `v1:${key32()}, v3:${key32()},v2:${key32()}`,
    });
    expect(config.TOKEN_ENCRYPTION_KEYS.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(config.TOKEN_ENCRYPTION_KEYS.every((entry) => entry.key.length === 32)).toBe(true);
  });

  it('rejects encryption keys of the wrong length, format or with repeated versions', () => {
    expect(
      problems({ TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(16).toString('base64')}` })[0],
    ).toMatch(/32 bytes/);
    expect(problems({ TOKEN_ENCRYPTION_KEYS: key32() })[0]).toMatch(/v<number>/);
    expect(problems({ TOKEN_ENCRYPTION_KEYS: `v1:${key32()},v1:${key32()}` })[0]).toMatch(/unique/);
  });

  it('requires LINK_SIGNING_SECRET to be at least 32 characters', () => {
    expect(problems({ LINK_SIGNING_SECRET: 'short' })[0]).toBe(
      'LINK_SIGNING_SECRET: must be at least 32 characters',
    );
  });

  it('parses comma-separated lists and validates each entry', () => {
    const config = loadConfig({ ...required, SITE_ALLOWLIST: ' youtube, vimeo ,,soundcloud' });
    expect(config.SITE_ALLOWLIST).toEqual(['youtube', 'vimeo', 'soundcloud']);
    expect(problems({ GEO_BYPASS_ALLOWLIST: 'US,usa' })[0]).toMatch(/^GEO_BYPASS_ALLOWLIST\.1:/);
  });

  it('parses the proxy pool and checks that per-extractor defaults name a pool entry', () => {
    const config = loadConfig({
      ...required,
      PROXY_POOL: '{"resi":"http://user:pw@proxy.example:8000"}',
      PROXY_DEFAULT_BY_EXTRACTOR: '{"youtube":"resi"}',
    });
    expect(config.PROXY_DEFAULT_BY_EXTRACTOR).toEqual({ youtube: 'resi' });
    expect(problems({ PROXY_POOL: '{not json' })[0]).toBe('PROXY_POOL: must be valid JSON');
    expect(problems({ PROXY_POOL: '{"a":"ftp://x"}' })[0]).toMatch(/must be a proxy URL/);
    expect(problems({ PROXY_DEFAULT_BY_EXTRACTOR: '{"youtube":"missing"}' })[0]).toMatch(
      /not in PROXY_POOL/,
    );
  });

  it('defaults the whisper model to the first configured one and validates an explicit default', () => {
    const models = '{"fast":"/models/base.bin","accurate":"/models/large.bin"}';
    expect(
      loadConfig({ ...required, FFMPEG_WHISPER_MODELS: models }).FFMPEG_WHISPER_DEFAULT_MODEL,
    ).toBe('fast');
    expect(
      loadConfig({
        ...required,
        FFMPEG_WHISPER_MODELS: models,
        FFMPEG_WHISPER_DEFAULT_MODEL: 'accurate',
      }).FFMPEG_WHISPER_DEFAULT_MODEL,
    ).toBe('accurate');
    expect(
      problems({ FFMPEG_WHISPER_MODELS: models, FFMPEG_WHISPER_DEFAULT_MODEL: 'huge' })[0],
    ).toMatch(/one of the names/);
    expect(problems({ FFMPEG_WHISPER_MODELS: '{"fast":"relative.bin"}' })[0]).toMatch(
      /absolute path/,
    );
  });

  it('treats an empty impersonation target as disabled and rejects unknown targets', () => {
    expect(
      loadConfig({ ...required, YTDLP_IMPERSONATE_DEFAULT: '' }).YTDLP_IMPERSONATE_DEFAULT,
    ).toBe('none');
    expect(problems({ YTDLP_IMPERSONATE_DEFAULT: 'netscape' })[0]).toMatch(
      /^YTDLP_IMPERSONATE_DEFAULT:/,
    );
  });

  it('requires the Google OAuth client id and secret together', () => {
    expect(problems({ GOOGLE_CLIENT_ID: 'id' })[0]).toMatch(/must be set together/);
    expect(problems({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).toEqual([]);
  });

  it('keeps uploads within the file size limit', () => {
    expect(problems({ MAX_UPLOAD_SIZE_MB: '5000', MAX_FILE_SIZE_MB: '4096' })[0]).toMatch(
      /must not exceed MAX_FILE_SIZE_MB/,
    );
  });
});
