/**
 * MV3 manifest (built by `@crxjs/vite-plugin`): side panel, options page, service worker and
 * content scripts.
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
  // Public key pinning the extension id to `EXTENSION_ID`, so `auth.ts`'s `trustedOrigins` can list
  // it. `manifest.test.ts` asserts the two match.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxHCAgIsu0C+GZhKbMXMdRq9UPEy1NH5VZ0WzxsnrV7F3jOIRnn8pv6t7pcvLuh421jcamfnR5ADLCHy8Jbc+IsRvX+9LuA8Q1PmMDhbwzPQlW3RxgPs0pwsCUDQpFdK7m6klk/acXr3O4ytpZaoISaTjHOotYQeygqG4GXM8vq8Jqxl5INYd53/fdNlJNSwSOmvYCFNuVDhp4wO1q8XrLSQWplo2WRqa6EvA+BACgYXzVUZ/1KDLhGLoEKPr3KOTE5TjDc6Nnx7OX3BrGll7kQbI8cpaYVmhV/thSLqYmzUH048X5i2T13NyPmjrimoQqzGPl4ep0Xz67RT539ci1QIDAQAB',
  icons: {
    16: 'src/assets/icons/icon16.png',
    48: 'src/assets/icons/icon48.png',
    128: 'src/assets/icons/icon128.png',
  },
  action: {
    // No popup: the icon opens the side panel (`service-worker.ts`), which survives outside clicks.
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
      // Every page: ATS boards are often white-labeled onto company domains, so `detect.ts` decides
      // whether a page is an application form.
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
  ],
  host_permissions: [
    `${EXTENSION_BACKEND_ORIGIN}/*`,
    // Local dev only (see `DASHBOARD_DEV_ORIGINS`).
    ...DASHBOARD_DEV_ORIGINS.map((origin) => `${origin}/*`),
    'https://boards-api.greenhouse.io/*',
    // No Ashby host: there's no working Ashby oracle (see `apiDetectors.ts`).
    'https://api.smartrecruiters.com/*',
    'https://*.workable.com/*',
  ],
  // `tabs` keeps `Tab.url` available as the panel follows an ATS flow (`activeTab` is revoked on
  // navigation). `cookies` is for `lib/sharedSessionCookie.ts`.
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
