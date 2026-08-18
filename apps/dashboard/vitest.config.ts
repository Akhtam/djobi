/** Vitest config for `apps/dashboard` — jsdom (React component tests), no injected test globals. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
