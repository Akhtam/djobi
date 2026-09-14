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

// A stale tab after a redeploy asks for chunk files that no longer exist. Reload once to pick up the
// new build; the session flag stops a genuinely broken deploy from reloading forever.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (sessionStorage.getItem('djobi:chunk-reload')) return;
    sessionStorage.setItem('djobi:chunk-reload', '1');
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});
// Cleared only after the reloaded page has had time to fetch its route's chunk, so a failure right
// after the reload still hits the flag instead of looping.
window.setTimeout(() => {
  try {
    sessionStorage.removeItem('djobi:chunk-reload');
  } catch {
    // storage unavailable — nothing to clear
  }
}, 10_000);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={httpDashboardClient} />
  </StrictMode>,
);
