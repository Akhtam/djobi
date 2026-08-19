/**
 * Mounts the review `App` (see `panel/index.html`) into `#root`. The side panel is the extension's
 * only UI surface — opened via the toolbar icon (`chrome.sidePanel.setPanelBehavior` in
 * `service-worker.ts`) or Chrome's built-in side-panel picker.
 *
 * The one place the panel names its real backend adapter. Every module below takes the
 * `BackendClient` it is given, so tests drive the whole panel through a fake at the same seam.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { httpBackendClient } from '../lib/backendClient';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={httpBackendClient} />
  </StrictMode>,
);
