import { type AppConfig, envSchema } from './env.schema';

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses the environment. Empty values count as unset, so `KEY=` in .env falls back to the
 * default, except where an empty value has a meaning of its own. Error messages name the
 * variable but never echo its value, because many values are secrets.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') input[key] = value;
  }
  if (env.YTDLP_IMPERSONATE_DEFAULT === '') input.YTDLP_IMPERSONATE_DEFAULT = 'none';

  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(env)';
        const missing =
          issue.code === 'invalid_type' &&
          issue.path.length === 1 &&
          !(String(issue.path[0]) in input);
        return `${name}: ${missing ? 'is required' : issue.message}`;
      }),
    );
  }
  return Object.freeze(result.data);
}
