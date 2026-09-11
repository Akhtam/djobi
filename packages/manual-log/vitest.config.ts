/** Vitest config for `packages/manual-log` — jsdom, since `useManualLogFlow` is a React hook. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
