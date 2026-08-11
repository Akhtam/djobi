/**
 * MV3 manifest (built by `@crxjs/vite-plugin`, consumed by `vite.config.ts`). Declares the side
 * panel, options page, background service worker, and the content-script matches.
 */
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

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
    // No default_popup: the toolbar icon opens the side panel instead (wired via
    // chrome.sidePanel.setPanelBehavior in service-worker.ts) — a side panel doesn't close on an
    // outside click the way a popup does, so review progress survives incidental blur.
    default_icon: {
      16: 'src/assets/icons/icon16.png',
      48: 'src/assets/icons/icon48.png',
      128: 'src/assets/icons/icon128.png',
    },
  },
  side_panel: {
    default_path: 'src/panel/index.html',
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      // Not a fixed ATS-domain allowlist: ATS platforms (Ashby, Greenhouse, Lever, Workable...)
      // let companies white-label their job board onto their own domain (e.g. Ashby embedded at
      // superhuman.com/company/careers/jobs), so the content script needs to run everywhere and
      // rely on `detect.ts`'s DOM heuristic to decide a given page is actually a job application.
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
  ],
  host_permissions: [
    'http://127.0.0.1:5391/*',
    'https://boards-api.greenhouse.io/*',
    'https://api.ashbyhq.com/*',
    'https://api.smartrecruiters.com/*',
    'https://*.workable.com/*',
  ],
  permissions: ['storage', 'scripting', 'activeTab', 'sidePanel'],
});
