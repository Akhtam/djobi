/** Vitest config for `apps/extension` — plain Node environment, no injected test globals. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
  },
});
