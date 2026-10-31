import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests of the user-facing pages (SPEC §16 E2E): the Google Drive callback. The API runs
 * from dist/ (test/e2e/server.mjs) with Google mocked in its process.
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4310', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node test/e2e/server.mjs',
    url: 'http://127.0.0.1:4310/health',
    timeout: 180_000,
    reuseExistingServer: false,
    env: { E2E_STATE_FILE: '/tmp/media-e2e.json', E2E_PORT: '4310' },
  },
});
