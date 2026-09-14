/**
 * MV3 manifest (built by `@crxjs/vite-plugin`, consumed by `vite.config.ts`). Declares the side
 * panel, options page, background service worker, and the content-script matches.
 */
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };
import { DASHBOARD_DEV_ORIGINS, EXTENSION_BACKEND_ORIGIN } from './extensionConfig.ts';

export default defineManifest({
  manifest_version: 3,
  name: 'djobi — Job Application Autofill',
  version: pkg.version,
  description:
    'Fills job applications with a resume tailored to the posting, then tracks every one you send.',
  // Pins this extension's id to `EXTENSION_ID` regardless of load order or machine — an unpinned
  // dev build gets a fresh random id every reload, which `apps/backend/src/auth.ts`'s
  // `trustedOrigins` can't whitelist (`docs/multi-tenant-auth.md`, Phase D). Only the *public* half
  // of the keypair; the private half never leaves `~/.djobi-secrets` and is not needed again unless
  // this is ever packaged as a signed `.crx` for the Chrome Web Store. `manifest.test.ts` asserts
  // this base64 actually derives to `EXTENSION_ID` — the two are otherwise free to drift silently.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxHCAgIsu0C+GZhKbMXMdRq9UPEy1NH5VZ0WzxsnrV7F3jOIRnn8pv6t7pcvLuh421jcamfnR5ADLCHy8Jbc+IsRvX+9LuA8Q1PmMDhbwzPQlW3RxgPs0pwsCUDQpFdK7m6klk/acXr3O4ytpZaoISaTjHOotYQeygqG4GXM8vq8Jqxl5INYd53/fdNlJNSwSOmvYCFNuVDhp4wO1q8XrLSQWplo2WRqa6EvA+BACgYXzVUZ/1KDLhGLoEKPr3KOTE5TjDc6Nnx7OX3BrGll7kQbI8cpaYVmhV/thSLqYmzUH048X5i2T13NyPmjrimoQqzGPl4ep0Xz67RT539ci1QIDAQAB',
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
    `${EXTENSION_BACKEND_ORIGIN}/*`,
    // Empty once a real deployed backend is named — see `DASHBOARD_DEV_ORIGINS`'s own doc comment
    // for why `chrome.cookies` needs these two in local dev: the dashboard's session cookie doesn't
    // live on `EXTENSION_BACKEND_ORIGIN` there.
    ...DASHBOARD_DEV_ORIGINS.map((origin) => `${origin}/*`),
    'https://boards-api.greenhouse.io/*',
    // No `api.ashbyhq.com` — the oracle that used it was removed (it only ever got 401s; see
    // `background/apiDetectors.ts`). The endpoint that does work is on `jobs.ashbyhq.com`, so
    // rebuilding that oracle means granting *that* host, not restoring this one.
    'https://api.smartrecruiters.com/*',
    'https://*.workable.com/*',
  ],
  // `activeTab` is temporary and is revoked on navigation; `tabs` keeps `Tab.url` available while
  // the side panel follows an application through an ATS flow.
  // `cookies` is `lib/sharedSessionCookie.ts`'s: reading/writing the dashboard's Better Auth
  // session cookie so a sign-in on either surface authenticates the other. It only reaches
  // `host_permissions`-granted origins, `EXTENSION_BACKEND_ORIGIN` among them.
  permissions: [
    'storage',
    'scripting',
    'activeTab',
    'sidePanel',
    'tabs',
    'webNavigation',
    'cookies',
  ],
});
