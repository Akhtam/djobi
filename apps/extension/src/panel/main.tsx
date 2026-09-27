/**
 * Mounts the side panel `App` (opened from the toolbar icon, see `service-worker.ts`). The one
 * place the panel names its real backend adapter; everything below takes the `BackendClient` it's
 * given.
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
