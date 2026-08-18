/**
 * The dashboard's entry point.
 *
 * There is no fixture/real toggle here. The fixture client still exists for the test suite, but a
 * runtime flag selecting it is a flag that can be left on by accident — and an app that appears to
 * be saving while writing to memory hides the failure until a reload throws the work away. If the
 * backend isn't running, this should say so, which is what `httpDashboardClient` does.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './App.css';
import { httpDashboardClient } from './lib/dashboardClient';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={httpDashboardClient} />
  </StrictMode>,
);
