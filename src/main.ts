import 'reflect-metadata';

import { createApp } from './app';
import { ConfigError, loadConfig } from './config/load-config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
