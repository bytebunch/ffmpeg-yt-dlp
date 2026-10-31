import 'reflect-metadata';

import { parseArgs } from 'node:util';

import { CookiesService } from './access/cookies.service';
import { CredentialsService } from './access/credentials.service';
import { ApiKeyService } from './auth/api-keys';
import { AppError } from './common/errors';
import { ConfigError, loadConfig } from './config/load-config';
import { DriveConnections } from './drive/drive-connections.service';
import { GoogleOAuth } from './drive/google-oauth';
import { createDatabase, createPool } from './db/database';

export const USAGE = `Usage: cli <command> [options]

  keys:create <client> [--default-user <id>] [--share-outputs] [--quiet]
      Creates an API key (and the client, if new). The key is shown once.
      --quiet prints only the key, for scripts.
  keys:revoke <prefix> | keys:revoke --key <key>
      Revokes a key by its visible prefix (mk_xxxxxxxx) or by the full key.
  keys:list [--client <name>]
      Lists keys: prefix, client, default user, created, last used, revoked.
  secrets:reencrypt
      Re-encrypts cookie jars, site credentials and Google Drive tokens with the newest
      TOKEN_ENCRYPTION_KEYS key, so older keys can be removed (key rotation).`;

export interface CliServices {
  keys: ApiKeyService;
  /** Re-encrypts stored secrets with the newest key; returns the rows changed per kind. */
  reencrypt: () => Promise<{ cookies: number; credentials: number; drive: number }>;
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const OPTIONS = {
  quiet: { type: 'boolean' },
  key: { type: 'string' },
  'default-user': { type: 'string' },
  'share-outputs': { type: 'boolean' },
  client: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const date = (value: Date | null) =>
  value ? value.toISOString().slice(0, 16).replace('T', ' ') : '-';

/** Runs one CLI command; returns the process exit code (0 ok, 1 failed, 2 usage). */
export async function runCli(argv: string[], services: CliServices, io: CliIo): Promise<number> {
  const { keys } = services;
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  switch (command) {
    case 'keys:create': {
      const [clientName] = rest;
      if (clientName === undefined || rest.length > 1) break;
      const created = await keys.create({
        clientName,
        defaultUserId: values['default-user'],
        shareOutputsWithinClient: values['share-outputs'],
      });
      if (values.quiet) {
        io.out(created.key);
      } else {
        io.out(
          `API key for client "${clientName}" (prefix ${created.prefix}):\n\n  ${created.key}\n`,
        );
        io.out('Store it now: it is not saved and cannot be shown again.');
      }
      return 0;
    }
    case 'keys:revoke': {
      const [prefix] = rest;
      const selector =
        values.key !== undefined && prefix === undefined
          ? { key: values.key }
          : prefix !== undefined && values.key === undefined && rest.length === 1
            ? { prefix }
            : undefined;
      if (!selector) break;
      const revoked = await keys.revoke(selector);
      if (revoked === 0) {
        io.err('No active key matches.');
        return 1;
      }
      if (!values.quiet) io.out('Key revoked.');
      return 0;
    }
    case 'keys:list': {
      if (rest.length > 0) break;
      const rows = await keys.list(values.client);
      io.out(['PREFIX', 'CLIENT', 'DEFAULT USER', 'CREATED', 'LAST USED', 'REVOKED'].join('\t'));
      for (const row of rows) {
        io.out(
          [
            row.prefix,
            row.clientName,
            row.defaultUserId ?? '-',
            date(row.createdAt),
            date(row.lastUsedAt),
            date(row.revokedAt),
          ].join('\t'),
        );
      }
      return 0;
    }
    case 'secrets:reencrypt': {
      if (rest.length > 0) break;
      const changed = await services.reencrypt();
      io.out(
        `Re-encrypted ${changed.cookies} cookie jar(s), ${changed.credentials} credential(s) and ${changed.drive} Drive connection(s).`,
      );
      return 0;
    }
    default:
      io.err(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
  io.err(`Wrong arguments for ${command}.\n\n${USAGE}`);
  return 2;
}

async function main(): Promise<number> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, { ...config, DATABASE_POOL_MAX: 1 });
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  try {
    const db = createDatabase(pool);
    const services: CliServices = {
      keys: new ApiKeyService(db),
      reencrypt: async () => ({
        cookies: await new CookiesService(config, db).reencrypt(),
        credentials: await new CredentialsService(config, db).reencrypt(),
        drive: await new DriveConnections(config, db, new GoogleOAuth(config)).reencrypt(),
      }),
    };
    return await runCli(process.argv.slice(2), services, io);
  } catch (error) {
    io.err(error instanceof AppError ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof ConfigError ? error.message : error);
      process.exitCode = 1;
    },
  );
}
