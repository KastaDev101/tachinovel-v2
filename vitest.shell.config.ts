/** PC shell tests (WebKit + Capacitor native-bridge.js + built core): `npm run test:shell`. Not part of `npm test`. */
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/shell/**/*.shell.ts'], testTimeout: 120_000, hookTimeout: 180_000, fileParallelism: false },
});
