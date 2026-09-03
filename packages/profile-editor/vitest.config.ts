/** Vitest config for `packages/profile-editor` — jsdom, since `useProfileDraft` is a React hook. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
