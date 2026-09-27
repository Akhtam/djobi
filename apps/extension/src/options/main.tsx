/** Mounts the options page `App` and names its real backend adapter. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { httpBackendClient } from '../lib/backendClient';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={httpBackendClient} />
  </StrictMode>,
);
