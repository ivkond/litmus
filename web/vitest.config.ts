import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/lib/orchestrator/**'],
      exclude: ['src/lib/orchestrator/startup.ts', 'src/lib/orchestrator/types.ts'],
      thresholds: {
        lines: 85,
        functions: 70,
        branches: 60,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
