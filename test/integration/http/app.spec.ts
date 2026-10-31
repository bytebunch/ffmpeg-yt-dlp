import { Body, Controller, Get, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { createZodDto } from 'nestjs-zod';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiKeyService, type AuthContext } from '../../../src/auth/api-keys';
import { Auth } from '../../../src/auth/request-auth';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import { createTestApp, testConfig } from '../support/app';
import { poolFor, startPostgres, startRedis } from '../support/containers';

class ProbeBody extends createZodDto(z.object({ url: z.url(), max: z.number().int().max(10) })) {}

/** Test-only routes that exercise the guards, validation and error handling. */
@Controller('v1/_probe')
class ProbeController {
  @Get()
  whoami(@Auth() auth: AuthContext): AuthContext {
    return auth;
  }

  @Post()
  echo(@Body() body: ProbeBody): ProbeBody {
    return body;
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internals: postgres://user:pw@db');
  }
}

describe('HTTP API: auth, rate limits, errors, health (Postgres + Redis)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let keys: ApiKeyService;
  let app: NestFastifyApplication;

  const env = () => ({
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
    API_RATE_LIMIT_PER_MINUTE: '5',
  });

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    keys = new ApiKeyService(createDatabase(pool));
    app = await createTestApp(testConfig(env()), { controllers: [ProbeController] });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  describe('health, metrics and docs', () => {
    it('reports healthy dependencies without an API key', async () => {
      const response = await get('/health');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'ok',
        checks: { database: 'ok', redis: 'ok' },
      });
    });

    it('echoes a well-formed X-Request-Id and replaces a malformed one', async () => {
      expect((await get('/health', { 'x-request-id': 'abc-123' })).headers['x-request-id']).toBe(
        'abc-123',
      );
      const replaced = (await get('/health', { 'x-request-id': 'bad id!' })).headers[
        'x-request-id'
      ];
      expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('exposes Prometheus metrics labelled by route template', async () => {
      const { key } = await keys.create({ clientName: 'metrics-app' });
      await get('/v1/_probe', bearer(key));
      const response = await get('/metrics');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain(
        'http_request_duration_seconds_count{method="GET",route="/v1/_probe",status="200"}',
      );
      expect(response.body).toContain('process_cpu_seconds_total');
    });

    it('serves the OpenAPI document with bearer authentication', async () => {
      const response = await get('/docs/json');
      expect(response.statusCode).toBe(200);
      const document = response.json<{
        components: { securitySchemes: Record<string, unknown> };
      }>();
      expect(document.components.securitySchemes).toHaveProperty('bearer');
    });
  });

  describe('API key authentication', () => {
    it('rejects requests without a key in the uniform error shape', async () => {
      const response = await get('/v1/_probe');
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Send an API key as "Authorization: Bearer <key>"',
        },
      });
    });

    it('rejects malformed, unknown and revoked keys', async () => {
      const created = await keys.create({ clientName: 'revoked-app' });
      await keys.revoke({ prefix: created.prefix });
      for (const key of ['nonsense', `mk_${'A'.repeat(32)}`, created.key]) {
        const response = await get('/v1/_probe', bearer(key));
        expect(response.statusCode).toBe(401);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
      }
    });

    it('identifies the client, with the key default user unless X-User-Id overrides it', async () => {
      const { key, clientId } = await keys.create({
        clientName: 'web-app',
        defaultUserId: 'owner',
        shareOutputsWithinClient: true,
      });
      expect((await get('/v1/_probe', bearer(key))).json()).toMatchObject({
        clientId,
        clientName: 'web-app',
        userId: 'owner',
        shareOutputsWithinClient: true,
      });
      expect(
        (await get('/v1/_probe', { ...bearer(key), 'x-user-id': 'user-42' })).json(),
      ).toMatchObject({ userId: 'user-42' });
      const invalid = await get('/v1/_probe', { ...bearer(key), 'x-user-id': 'bad user' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    });

    it('records when a key was last used', async () => {
      const { key, prefix } = await keys.create({ clientName: 'touch-app' });
      await get('/v1/_probe', bearer(key));
      await expect
        .poll(
          async () =>
            (await keys.list('touch-app')).find((row) => row.prefix === prefix)?.lastUsedAt,
        )
        .toBeInstanceOf(Date);
    });
  });

  describe('rate limiting', () => {
    it('allows API_RATE_LIMIT_PER_MINUTE requests per key, then answers 429 with Retry-After', async () => {
      const { key } = await keys.create({ clientName: 'busy-app' });
      const remaining: string[] = [];
      for (let i = 0; i < 5; i++) {
        const response = await get('/v1/_probe', bearer(key));
        expect(response.statusCode).toBe(200);
        remaining.push(String(response.headers['x-ratelimit-remaining']));
      }
      expect(remaining).toEqual(['4', '3', '2', '1', '0']);
      const limited = await get('/v1/_probe', bearer(key));
      expect(limited.statusCode).toBe(429);
      expect(limited.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      const other = await keys.create({ clientName: 'quiet-app' });
      expect((await get('/v1/_probe', bearer(other.key))).statusCode).toBe(200);
    });
  });

  describe('validation and errors', () => {
    it('reports every invalid field', async () => {
      const { key } = await keys.create({ clientName: 'validating-app' });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/_probe',
        headers: bearer(key),
        payload: { url: 'not a url', max: 99 },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<{
        error: { code: string; details: { issues: { path: string }[] } };
      }>();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details.issues.map((issue) => issue.path).sort()).toEqual(['max', 'url']);
    });

    it('accepts a valid body', async () => {
      const { key } = await keys.create({ clientName: 'valid-app' });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/_probe',
        headers: bearer(key),
        payload: { url: 'https://example.com/v', max: 3 },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ url: 'https://example.com/v', max: 3 });
    });

    it('answers malformed JSON with VALIDATION_FAILED', async () => {
      const { key } = await keys.create({ clientName: 'json-app' });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/_probe',
        headers: { ...bearer(key), 'content-type': 'application/json' },
        payload: '{"url":',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    });

    it('answers unknown routes with NOT_FOUND', async () => {
      const response = await get('/v1/does-not-exist');
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    });

    it('hides unexpected errors behind INTERNAL', async () => {
      const { key } = await keys.create({ clientName: 'boom-app' });
      const response = await get('/v1/_probe/boom', bearer(key));
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal error' } });
      expect(response.body).not.toContain('postgres://');
    });
  });

  describe('when Redis is unreachable', () => {
    it('reports degraded health but keeps serving authenticated requests', async () => {
      const degraded = await createTestApp(
        testConfig({ ...env(), REDIS_URL: 'redis://127.0.0.1:1' }),
        { controllers: [ProbeController] },
      );
      try {
        const health = await degraded.inject({ method: 'GET', url: '/health' });
        expect(health.statusCode).toBe(503);
        expect(health.json()).toEqual({
          status: 'degraded',
          checks: { database: 'ok', redis: 'down' },
        });
        const { key } = await keys.create({ clientName: 'no-redis-app' });
        const response = await degraded.inject({
          method: 'GET',
          url: '/v1/_probe',
          headers: bearer(key),
        });
        expect(response.statusCode).toBe(200);
      } finally {
        await degraded.close();
      }
    });
  });
});
