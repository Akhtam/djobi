/**
 * Mounts the options page `App` (see `options/index.html`) into `#root`, and is the one place this
 * page names its real backend adapter — see `panel/main.tsx` for why that stays out of `App`.
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
