import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles the tests because esbuild cannot emit the decorator metadata Nest relies on.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        // Real sites over the network; run on demand with `pnpm test:live`.
        extends: true,
        test: {
          name: 'live',
          include: ['test/live/**/*.spec.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
