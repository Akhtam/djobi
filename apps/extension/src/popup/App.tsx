/**
 * Popup root — shows profile setup / supported-page status. The review/edit UI for a detected
 * job's tailored resume and drafted answers is deferred to Phase 6, once the content script can
 * actually detect a job posting (`PROGRESS.md` Phase 5).
 */
import { useEffect, useState } from 'react';
import { isSupportedAtsHost } from '../lib/atsHosts';
import { sendToBackground } from '../lib/sendToBackground';

type Status = 'loading' | 'no-profile' | 'unsupported-page' | 'ready';

export function App() {
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    Promise.all([
      sendToBackground<unknown | null>('/profile', undefined, 'GET'),
      new Promise<chrome.tabs.Tab[]>((resolve) =>
        chrome.tabs.query({ active: true, currentWindow: true }, resolve),
      ),
    ]).then(([profile, tabs]) => {
      if (!profile) {
        setStatus('no-profile');
        return;
      }

      const hostname = tabs[0]?.url ? new URL(tabs[0].url).hostname : '';
      setStatus(isSupportedAtsHost(hostname) ? 'ready' : 'unsupported-page');
    });
  }, []);

  return (
    <main>
      <h1>djobi</h1>
      {status === 'loading' && <p>Loading…</p>}
      {status === 'no-profile' && (
        <>
          <p>Set up your profile to get started.</p>
          <button type="button" onClick={() => chrome.runtime.openOptionsPage()}>
            Open profile settings
          </button>
        </>
      )}
      {status === 'unsupported-page' && (
        <p>Navigate to a supported job application page to get started.</p>
      )}
      {status === 'ready' && <p>djobi is ready on this page.</p>}
    </main>
  );
}
