/** Vitest config for `apps/backend` — plain Node environment, no injected test globals. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Suites that boot PGlite (WASM Postgres) need far longer than the 5s default on a shared
    // 4-vCPU CI runner, where 30 test files run in parallel.
    testTimeout: 20_000,
    // `auth.ts` refuses to construct Better Auth without `BETTER_AUTH_SECRET` set (a real .env is
    // not loaded for tests) — every suite that builds a real `auth` instance against PGlite
    // (`auth.test.ts`, `authMiddleware.test.ts`) needs some value here, and its exact contents
    // don't matter since nothing in this suite runs against a real deployment.
    env: {
      BETTER_AUTH_SECRET: 'test-only-secret-do-not-use-in-production',
    },
  },
});
