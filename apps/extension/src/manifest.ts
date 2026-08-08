import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

const ATS_HOST_PATTERNS = [
  '*://*.greenhouse.io/*',
  '*://*.ashbyhq.com/*',
  '*://*.lever.co/*',
  '*://*.myworkday.com/*',
  '*://*.smartrecruiters.com/*',
  '*://*.icims.com/*',
  '*://*.workable.com/*',
  '*://*.bamboohr.com/*',
];

export default defineManifest({
  manifest_version: 3,
  name: 'djobi — Job Application Autofill',
  version: pkg.version,
  description: 'Autofills job applications with an AI-tailored resume and drafted answers.',
  action: {
    default_popup: 'src/popup/index.html',
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
  permissions: ['storage', 'scripting'],
});
