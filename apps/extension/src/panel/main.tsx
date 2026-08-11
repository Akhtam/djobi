/**
 * Mounts the review `App` (see `panel/index.html`) into `#root`. The side panel is the extension's
 * only UI surface — opened via the toolbar icon (`chrome.sidePanel.setPanelBehavior` in
 * `service-worker.ts`) or Chrome's built-in side-panel picker.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
