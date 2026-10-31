import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { Public } from '../auth/request-auth';
import { PG_POOL, REDIS } from '../common/tokens';

const CHECK_TIMEOUT_MS = 2_000;

type CheckState = 'ok' | 'down';

async function check(probe: () => Promise<unknown>): Promise<CheckState> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timed out'));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: { database: CheckState; redis: CheckState };
}

/** Liveness and readiness: 200 when Postgres and Redis answer, 503 otherwise. */
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('health')
  async health(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReport> {
    const [database, redis] = await Promise.all([
      check(() => this.pool.query('SELECT 1')),
      check(() => this.redis.ping()),
    ]);
    const healthy = database === 'ok' && redis === 'ok';
    void reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', checks: { database, redis } };
  }
}
