// The API for the Playwright tests: the built app (dist/) on Testcontainers Postgres and Redis,
// with Google's OAuth token endpoint answered in-process by undici's MockAgent. Writes the
// base URL and an API key to E2E_STATE_FILE once it listens.
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import pg from 'pg';
import { MockAgent, setGlobalDispatcher } from 'undici';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const { createApp } = require('../../dist/app.js');
const { ApiKeyService } = require('../../dist/auth/api-keys.js');
const { loadConfig } = require('../../dist/config/load-config.js');
const { createDatabase } = require('../../dist/db/database.js');
const { runMigrations } = require('../../dist/db/migrations.js');

const PORT = Number(process.env.E2E_PORT ?? 4310);
const base = `http://127.0.0.1:${PORT}`;

const [postgres, redis] = await Promise.all([
  new PostgreSqlContainer('postgres:17-alpine').start(),
  new RedisContainer('redis:7-alpine').start(),
]);
const pool = new pg.Pool({ connectionString: postgres.getConnectionUri() });
await runMigrations(pool);
const { key } = await new ApiKeyService(createDatabase(pool)).create({
  clientName: 'e2e',
  defaultUserId: 'e2e-user',
});

const mock = new MockAgent();
mock.disableNetConnect();
mock.enableNetConnect(/^127\.0\.0\.1/);
setGlobalDispatcher(mock);
const idToken = [
  'e30',
  Buffer.from(JSON.stringify({ email: 'e2e@example.com' })).toString('base64url'),
  'sig',
].join('.');
mock
  .get('https://oauth2.googleapis.com')
  .intercept({ path: '/token', method: 'POST' })
  .reply(
    200,
    { access_token: 'ya29.e2e', refresh_token: '1//e2e', id_token: idToken, expires_in: 3599 },
    { headers: { 'content-type': 'application/json' } },
  )
  .persist();

const config = loadConfig({
  DATABASE_URL: postgres.getConnectionUri(),
  REDIS_URL: redis.getConnectionUrl(),
  PUBLIC_BASE_URL: base,
  LINK_SIGNING_SECRET: randomBytes(32).toString('hex'),
  TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
  GOOGLE_CLIENT_ID: 'e2e.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'e2e-secret',
  API_PORT: String(PORT),
  LOG_LEVEL: 'warn',
});
const app = await createApp(config);
await app.listen({ port: PORT, host: '127.0.0.1' });
writeFileSync(process.env.E2E_STATE_FILE ?? '/tmp/media-e2e.json', JSON.stringify({ base, key }));
console.log(`e2e API listening on ${base}`);

const stop = async () => {
  await app.close();
  await pool.end();
  await Promise.all([postgres.stop(), redis.stop()]);
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
