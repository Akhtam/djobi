/**
 * MV3 manifest (built by `@crxjs/vite-plugin`, consumed by `vite.config.ts`). Declares the popup,
 * options page, background service worker, and the ATS-host content-script matches.
 */
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };
import { ATS_HOST_PATTERNS } from './lib/atsHosts';

export default defineManifest({
  manifest_version: 3,
  name: 'djobi — Job Application Autofill',
  version: pkg.version,
  description: 'Autofills job applications with an AI-tailored resume and drafted answers.',
  icons: {
    16: 'src/assets/icons/icon16.png',
    48: 'src/assets/icons/icon48.png',
    128: 'src/assets/icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'src/assets/icons/icon16.png',
      48: 'src/assets/icons/icon48.png',
      128: 'src/assets/icons/icon128.png',
    },
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ATS_HOST_PATTERNS,
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  host_permissions: ['http://127.0.0.1:5391/*'],
  permissions: ['storage', 'scripting', 'activeTab'],
});
