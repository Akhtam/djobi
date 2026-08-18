/**
 * Vite config for `apps/dashboard` — a plain React SPA, unrelated to the extension's MV3 build.
 *
 * Port 5174 rather than 5173: 5173 is the extension dev server's `strictPort` and both are
 * routinely running at once.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
});
