/** Vitest config for `apps/extension` — jsdom environment (for React component tests), no injected test globals. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
