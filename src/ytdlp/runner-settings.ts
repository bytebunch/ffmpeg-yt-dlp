import type { AppConfig } from '../config/env.schema';
import type { RunnerSettings } from './runner';

export function runnerSettings(config: AppConfig): RunnerSettings {
  return {
    bin: config.YTDLP_BIN,
    denoBin: config.DENO_BIN,
    cacheDir: config.YTDLP_CACHE_DIR,
    extractors: config.SITE_ALLOWLIST,
    impersonate: config.YTDLP_IMPERSONATE_DEFAULT,
    sleepRequestsSeconds: config.YTDLP_SLEEP_REQUESTS_SECONDS,
    potProviderUrl: config.YTDLP_POT_PROVIDER_URL,
  };
}
