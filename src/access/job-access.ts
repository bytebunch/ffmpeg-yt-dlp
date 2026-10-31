import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import { accessArgs, selectProxy } from './access-args';
import { CookiesService } from './cookies.service';
import { CredentialsService } from './credentials.service';
import { type AccessOptions, PRIVATE_FIELDS } from './options';
import { unsealSecrets } from './sealed';

/** One job's access for its yt-dlp runs (SPEC §7f). */
export interface JobAccess {
  /** Flags for one run; the extractor (or, before extraction, the URL) picks the default proxy. */
  args: (target: { extractor?: string; url?: string }) => string[];
  /** Set when the job uses access only this user has: dedup and caches then stay per user. */
  privateScope: string | undefined;
  /** Separates cached extractions made with different access. */
  cacheScope: string;
  /** Shreds the job-local cookie file. */
  dispose: () => Promise<void>;
}

interface Owner {
  clientId: string;
  userId: string;
}

/** Overwrites, then removes: the jar is only ever on disk for the run (SPEC §12). */
async function shred(file: string): Promise<void> {
  try {
    const { size } = await stat(file);
    await writeFile(file, Buffer.alloc(size));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rm(file, { force: true });
}

@Injectable()
export class JobAccessResolver {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly cookies: CookiesService,
    private readonly credentials: CredentialsService,
  ) {}

  /** `dir` is job-local; the cookie file lives there until `dispose`. */
  async prepare(
    owner: Owner,
    options: AccessOptions,
    stored: Record<string, unknown>,
    dir: string,
  ): Promise<JobAccess> {
    this.checkConfig(options);
    const secrets = unsealSecrets(this.config.TOKEN_ENCRYPTION_KEYS, owner, stored);
    if (secrets?.tv_provider && !this.config.TV_PROVIDER_ENABLED) {
      throw new AppError(
        'FEATURE_DISABLED',
        'TV provider logins are disabled on this server',
        undefined,
        {},
        false,
      );
    }
    const login =
      options.credentials === undefined
        ? undefined
        : await this.credentials.login(owner, options.credentials);
    let cookieFile: string | undefined;
    if (options.cookies !== undefined) {
      const text = await this.cookies.jarText(owner, options.cookies);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      cookieFile = path.join(dir, 'cookies.txt');
      await writeFile(cookieFile, text, { mode: 0o600 });
    }
    const isPrivate =
      PRIVATE_FIELDS.some((field) => options[field] !== undefined) || secrets !== undefined;
    const privateScope = isPrivate ? `${owner.clientId}:${owner.userId}` : undefined;
    return {
      args: (target) =>
        accessArgs({
          ...(cookieFile !== undefined && { cookieFile }),
          ...(login && { login }),
          ...(secrets && { secrets }),
          ...this.proxy(options, target),
          ...(options.geo_country !== undefined && { geoCountry: options.geo_country }),
          ...(options.mark_watched === true && { markWatched: true }),
        }),
      privateScope,
      cacheScope: JSON.stringify([privateScope ?? null, options.geo_country ?? null]),
      dispose: () => (cookieFile === undefined ? Promise.resolve() : shred(cookieFile)),
    };
  }

  private proxy(options: AccessOptions, target: { extractor?: string; url?: string }) {
    const proxyUrl = selectProxy(
      this.config.PROXY_POOL,
      this.config.PROXY_DEFAULT_BY_EXTRACTOR,
      options.proxy,
      target,
    );
    return proxyUrl === undefined ? {} : { proxyUrl };
  }

  /** The owner may have changed the configuration since the job was accepted. */
  private checkConfig(options: AccessOptions): void {
    if (options.proxy !== undefined && !(options.proxy in this.config.PROXY_POOL)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `proxy "${options.proxy}" is not configured on this server`,
        undefined,
        {},
        false,
      );
    }
    if (
      options.geo_country !== undefined &&
      !this.config.GEO_BYPASS_ALLOWLIST.includes(options.geo_country)
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        `geo_country ${options.geo_country} is not allowed on this server`,
        undefined,
        {},
        false,
      );
    }
  }
}
