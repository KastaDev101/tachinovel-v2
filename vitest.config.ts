import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{ find: /^@v1\/(.*)$/, replacement: path.resolve(import.meta.dirname, 'vendor/v1/src/$1') }],
  },
  define: {
    __BUILD_VERSION__: JSON.stringify('test'),
    __BUILD_HASH__: JSON.stringify('test'),
    __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00Z'),
    __DEV_BUILD__: 'false',
    __FLAVOR__: JSON.stringify('store'),
    __ADS__: 'false',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
