import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { AppError } from '../common/errors';
import { APP_CONFIG, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import { API_KEY_PATTERN, ApiKeyService } from './api-keys';
import { bearerToken, IS_PUBLIC, resolveUserId } from './request-auth';

const TOUCH_INTERVAL_MS = 60_000;

function isPublic(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

/** Authenticates `Authorization: Bearer <key>` on every route not marked @Public(). */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly reflector: Reflector,
    private readonly keys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const key = bearerToken(request.headers.authorization);
    if (key === undefined) {
      throw new AppError('UNAUTHORIZED', 'Send an API key as "Authorization: Bearer <key>"');
    }
    const record = API_KEY_PATTERN.test(key) ? await this.keys.authenticate(key) : undefined;
    if (!record) throw new AppError('UNAUTHORIZED', 'The API key is invalid or revoked');

    request.auth = {
      keyId: record.keyId,
      clientId: record.clientId,
      clientName: record.clientName,
      userId: resolveUserId(request.headers['x-user-id'], record.defaultUserId),
      shareOutputsWithinClient: record.shareOutputsWithinClient,
    };
    this.recordUse(record.keyId);
    return true;
  }

  /** Updates last_used_at at most once a minute per key, off the request path. */
  private recordUse(keyId: string): void {
    const now = Date.now();
    if (now - (this.lastTouched.get(keyId) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.lastTouched.set(keyId, now);
    this.keys.touch(keyId).catch((error: unknown) => {
      this.logger.warn({ err: error, keyId }, 'Could not record API key use');
    });
  }
}

export interface RateWindow {
  window: number;
  resetSeconds: number;
}

export function rateWindow(now: number): RateWindow {
  return { window: Math.floor(now / 60_000), resetSeconds: 60 - Math.floor((now % 60_000) / 1000) };
}

/**
 * Per-key request limit (API_RATE_LIMIT_PER_MINUTE) in fixed one-minute windows in Redis.
 * When Redis is unreachable the request is allowed and the failure logged: refusing every
 * request would turn a cache outage into a full outage, and /health already reports Redis.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;
    const http = context.switchToHttp();
    const auth = http.getRequest<FastifyRequest>().auth;
    if (!auth) return true;

    const limit = this.config.API_RATE_LIMIT_PER_MINUTE;
    const { window, resetSeconds } = rateWindow(Date.now());
    const key = `rl:api:${auth.keyId}:${window}`;
    let count: number;
    try {
      const results = await this.redis.multi().incr(key).expire(key, 120).exec();
      count = Number(results?.[0]?.[1]);
    } catch (error) {
      this.logger.error({ err: error }, 'Rate limiting skipped: Redis is unavailable');
      return true;
    }
    void http
      .getResponse<FastifyReply>()
      .header('x-ratelimit-limit', String(limit))
      .header('x-ratelimit-remaining', String(Math.max(0, limit - count)));
    if (count > limit) {
      throw new AppError(
        'RATE_LIMITED',
        `This API key is limited to ${limit} requests per minute`,
        { limit },
        { 'retry-after': String(resetSeconds) },
      );
    }
    return true;
  }
}
