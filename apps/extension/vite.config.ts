/**
 * Vite config for the MV3 extension build — `@crxjs/vite-plugin` packages `manifest.ts` and its
 * referenced entrypoints (popup/options/background/content) into a loadable `dist/`.
 */
import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './src/manifest.ts';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: { sourcemap: true },
  server: {
    port: 5173,
    strictPort: true,
  },
});
