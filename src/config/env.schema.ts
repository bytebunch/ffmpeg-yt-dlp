import { z } from 'zod';

/**
 * Every environment variable the service reads (SPEC §13). The service refuses to start when
 * any value is invalid; .env.example documents each one.
 */

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const decimal = (fallback: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(fallback);

const bool = (fallback: boolean) => z.stringbool().default(fallback);

const absolutePath = z.string().regex(/^\/[^\0]*$/, 'must be an absolute path');

const csv = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(item));

const json = <T extends z.ZodType>(shape: T) =>
  z
    .string()
    .transform((value, ctx): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(shape);

const originUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === '/' && url.search === '' && url.hash === '';
  }, 'must be scheme://host[:port] without a path')
  .transform((value) => new URL(value).origin);

const encryptionKeys = z.string().transform((value, ctx) => {
  const keys = value.split(',').map((entry) => {
    const match = /^v(\d{1,4}):([A-Za-z0-9+/]+={0,2})$/.exec(entry.trim());
    const key = match?.[2] ? Buffer.from(match[2], 'base64') : undefined;
    if (!match?.[1] || key?.length !== 32) {
      ctx.addIssue({
        code: 'custom',
        message:
          'each key must be v<number>:<base64 of 32 bytes>, e.g. v1:$(openssl rand -base64 32)',
      });
      return undefined;
    }
    return { version: Number(match[1]), key };
  });
  if (keys.some((entry) => entry === undefined)) return z.NEVER;
  const valid = keys.filter((entry) => entry !== undefined);
  if (new Set(valid.map((entry) => entry.version)).size !== valid.length) {
    ctx.addIssue({ code: 'custom', message: 'key versions must be unique' });
    return z.NEVER;
  }
  return valid.sort((a, b) => b.version - a.version);
});

const IMPERSONATE_TARGETS = [
  'chrome',
  'chrome-android',
  'safari',
  'safari-ios',
  'edge',
  'firefox',
] as const;

export const envSchema = z
  .object({
    // Limits and quotas
    DOWNLOAD_CONCURRENCY: int(4, 1, 64),
    FFMPEG_CONCURRENCY: int(2, 1, 64),
    FFMPEG_THREADS: int(4, 1, 128),
    FFMPEG_HWACCEL: z.enum(['none', 'vaapi', 'nvenc', 'qsv']).default('none'),
    USER_MAX_CONCURRENT_ITEMS: int(2, 1, 100),
    USER_MAX_ITEMS_PER_DAY: int(300, 1, 100_000),
    USER_MAX_PROCESS_MINUTES_PER_DAY: int(600, 1, 1_000_000),
    USER_MAX_UPLOAD_MB_PER_DAY: int(20_480, 1, 10_000_000),
    PLAYLIST_MAX_ITEMS: int(100, 1, 10_000),
    PLAYLIST_MAX_TOTAL_DURATION_HOURS: int(24, 1, 10_000),
    PLAYLIST_UNKNOWN_DURATION_MINUTES: int(10, 1, 1440),
    PLAYLIST_EXPAND_TIMEOUT_SECONDS: int(120, 5, 3600),
    PLAYLIST_CACHE_TTL_MINUTES: int(60, 0, 10_080),
    BATCH_MAX_URLS: int(50, 1, 1000),
    API_RATE_LIMIT_PER_MINUTE: int(120, 1, 100_000),
    MAX_MEDIA_DURATION_MINUTES: int(240, 1, 10_080),
    MAX_FILE_SIZE_MB: int(4096, 1, 1_048_576),
    MAX_UPLOAD_SIZE_MB: int(4096, 1, 1_048_576),
    UPLOAD_TTL_HOURS: int(24, 1, 720),
    INPUT_CACHE_HOURS: int(6, 0, 720),
    PROBE_MAX_MB: int(64, 1, 4096),
    COMMENTS_SYNC_MAX: int(200, 1, 10_000),
    JOB_TIMEOUT_MINUTES: int(60, 1, 10_080),
    RECIPE_TIMEOUT_BASE_MINUTES: int(5, 1, 1440),
    RECIPE_TIMEOUT_FACTOR: decimal(2, 0.1, 100),
    RECIPE_MAX_COST: int(5000, 1, 10_000_000),
    RECIPE_MAX_STEPS: int(25, 1, 500),
    RECIPE_MAX_INPUTS: int(20, 1, 500),
    RECIPE_MAX_OUTPUTS: int(10, 1, 500),
    RECIPE_MAX_TEXT_LAYERS: int(8, 0, 100),
    REVERSE_MAX_SECONDS: int(60, 1, 3600),
    INTERPOLATE_MAX_SECONDS: int(120, 1, 3600),
    GIF_MAX_SECONDS: int(30, 1, 600),
    FRAMES_MAX_COUNT: int(2000, 1, 100_000),
    LIVE_MAX_DURATION_MINUTES: int(360, 1, 10_080),
    LIVE_MAX_WAIT_MINUTES: int(720, 0, 43_200),
    JOB_RATE_LIMIT_MAX_KBPS: int(0, 0, 100_000_000),
    TRANSCRIPT_TIMEOUT_SECONDS: int(60, 5, 600),
    FILE_TTL_DAYS: int(7, 1, 365),
    DISK_QUOTA_PERCENT: int(80, 1, 99),
    OAUTH_STATE_TTL_MINUTES: int(10, 1, 120),
    WATCH_MIN_INTERVAL_MINUTES: int(30, 1, 10_080),
    WATCH_MAX_NEW_ITEMS: int(20, 1, 1000),
    WATCH_MAX_FAILURES: int(5, 1, 100),
    SITE_ALLOWLIST: csv(z.string().regex(/^[A-Za-z0-9_:.-]+$/, 'extractor names only')).default([]),

    // yt-dlp behaviour
    YTDLP_IMPERSONATE_DEFAULT: z.enum([...IMPERSONATE_TARGETS, 'none']).default('chrome'),
    YTDLP_POT_PROVIDER_URL: z.url({ protocol: /^https?$/ }).optional(),
    YTDLP_ALLOWED_PLAYER_CLIENTS: csv(z.string().regex(/^[a-z_]+$/)).default([]),
    YTDLP_SLEEP_REQUESTS_SECONDS: decimal(0, 0, 60),
    PROXY_POOL: json(
      z.record(
        z.string().regex(/^[a-z0-9_-]{1,32}$/, 'proxy names: a-z, 0-9, _ and -'),
        z.url({ protocol: /^(https?|socks4a?|socks5h?)$/, error: 'must be a proxy URL' }),
      ),
    ).default({}),
    PROXY_DEFAULT_BY_EXTRACTOR: json(z.record(z.string(), z.string())).default({}),
    GEO_BYPASS_ALLOWLIST: csv(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 codes')).default(
      [],
    ),
    SPONSORBLOCK_API_URL: z.url({ protocol: /^https?$/ }).default('https://sponsor.ajay.app'),
    SITE_CREDENTIALS_ENABLED: bool(false),
    TV_PROVIDER_ENABLED: bool(false),
    FFMPEG_WHISPER_MODELS: json(
      z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/), absolutePath),
    ).default({}),
    FFMPEG_WHISPER_DEFAULT_MODEL: z.string().optional(),
    FFMPEG_WHISPER_VAD_MODEL: absolutePath.optional(),
    FONT_DIR: absolutePath.default('/usr/share/fonts'),

    // Binaries (not in SPEC §13: defaults match the image; tests point them at fakes)
    YTDLP_BIN: z.string().min(1).default('yt-dlp'),
    DENO_BIN: z.string().min(1).default('deno'),
    FFMPEG_BIN: z.string().min(1).default('ffmpeg'),
    FFPROBE_BIN: z.string().min(1).default('ffprobe'),
    YTDLP_CACHE_DIR: absolutePath.optional(),

    // Infrastructure and secrets
    PUBLIC_BASE_URL: originUrl,
    API_PORT: int(3000, 1, 65_535),
    WORKER_ROLE: z.enum(['download', 'ffmpeg']).optional(),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// URL'),
    DATABASE_MIGRATION_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// URL')
      .optional(),
    DATABASE_SSL_MODE: z
      .enum(['disable', 'require', 'verify-ca', 'verify-full'])
      .default('disable'),
    DATABASE_SSL_CA_FILE: absolutePath.optional(),
    DATABASE_POOL_MAX: int(10, 1, 500),
    REDIS_URL: z.string().regex(/^rediss?:\/\/.+/, 'must be a redis:// or rediss:// URL'),
    BACKUP_ENABLED: bool(true),
    FILES_DIR: absolutePath.default('/data/files'),
    INBOX_DIR: absolutePath.default('/data/inbox'),
    NGINX_INTERNAL_FILES_PREFIX: z
      .string()
      .regex(/^\/[A-Za-z0-9_/-]*\/$/, 'must start and end with /')
      .default('/_files/'),
    LINK_SIGNING_SECRET: z.string().min(32, 'must be at least 32 characters'),
    TOKEN_ENCRYPTION_KEYS: encryptionKeys,
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_API_KEY: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.MAX_UPLOAD_SIZE_MB > env.MAX_FILE_SIZE_MB) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_UPLOAD_SIZE_MB'],
        message: 'must not exceed MAX_FILE_SIZE_MB',
      });
    }
    for (const [extractor, proxy] of Object.entries(env.PROXY_DEFAULT_BY_EXTRACTOR)) {
      if (!(proxy in env.PROXY_POOL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['PROXY_DEFAULT_BY_EXTRACTOR', extractor],
          message: `names proxy "${proxy}", which is not in PROXY_POOL`,
        });
      }
    }
    const models = Object.keys(env.FFMPEG_WHISPER_MODELS);
    const defaultModel = env.FFMPEG_WHISPER_DEFAULT_MODEL;
    if (defaultModel !== undefined && !models.includes(defaultModel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['FFMPEG_WHISPER_DEFAULT_MODEL'],
        message: 'must be one of the names in FFMPEG_WHISPER_MODELS',
      });
    }
    if ((env.GOOGLE_CLIENT_ID === undefined) !== (env.GOOGLE_CLIENT_SECRET === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_SECRET'],
        message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
      });
    }
  })
  .transform((env) => ({
    ...env,
    DATABASE_MIGRATION_URL: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    YTDLP_CACHE_DIR: env.YTDLP_CACHE_DIR ?? `${env.FILES_DIR}/.cache/yt-dlp`,
    FFMPEG_WHISPER_DEFAULT_MODEL:
      env.FFMPEG_WHISPER_DEFAULT_MODEL ?? Object.keys(env.FFMPEG_WHISPER_MODELS)[0],
  }));

export type AppConfig = Readonly<z.infer<typeof envSchema>>;
