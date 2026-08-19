/**
 * The on-demand Tailored Resume preview: render the PDF, hand back a URL to show it at, and revoke
 * that URL exactly once.
 *
 * "Exactly once" is the whole reason this is a module. A `blob:` URL outlives the state that names
 * it, so every path that drops one has to revoke it — a second preview, a change of page, an
 * unmount — and a request already in flight when any of those happens must not install its result
 * afterwards. Those rules were spread across two refs, two effects and two functions in the tab
 * that renders the preview, where each new caller had to remember all of them; a missed revoke
 * leaks the blob until the browser reclaims it, and a missed staleness check shows the previous
 * job's resume.
 *
 * Kept out of the persisted `PipelineRunState` deliberately: it is a display-only, expensive-to-
 * recompute blob URL that should not survive a panel reopen.
 */
import { useEffect, useRef, useState } from 'react';
import type { Profile, TailoredResume } from '@djobi/shared';
import type { BackendClient } from '../lib/backendClient';

/** What the preview looks like right now. `ready` carries the URL to point an iframe at. */
export type ResumePreviewState =
  { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error' };

export interface ResumePreview {
  state: ResumePreviewState;
  /** Renders the resume and shows it. A second call while one is loading is ignored. */
  show: () => void;
  /** Drops any preview and revokes its URL — for a page change, where a URL means nothing. */
  clear: () => void;
}

/**
 * @param client - The backend seam; only `renderResumePdf` is used.
 * @param profile - Rendered into the PDF's header and education section.
 * @param tailoredResume - What to render. `null` before analysis, and {@link ResumePreview.show}
 *   does nothing then — there is no resume to preview yet.
 */
export function useResumePreview(
  client: BackendClient,
  profile: Profile,
  tailoredResume: TailoredResume | null,
): ResumePreview {
  const [state, setState] = useState<ResumePreviewState>({ kind: 'idle' });
  const urlRef = useRef<string | null>(null);
  // Bumped by everything that invalidates an in-flight render, so its completion can tell that it
  // is no longer the preview anyone asked for.
  const requestRef = useRef(0);

  function clear() {
    ++requestRef.current;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setState({ kind: 'idle' });
  }

  function show() {
    if (!tailoredResume || state.kind === 'loading') return;
    clear();
    setState({ kind: 'loading' });
    const requestToken = requestRef.current;
    void client
      .renderResumePdf(profile, tailoredResume)
      .then((bytes) => {
        if (requestToken !== requestRef.current) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        // Re-checked after the URL exists: `createObjectURL` is synchronous, but the state that
        // decides whether we still want it can have changed while the bytes were in flight.
        // Without this the blob would be created and then dropped without ever being revoked.
        if (requestToken !== requestRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        urlRef.current = url;
        setState({ kind: 'ready', url });
      })
      .catch(() => {
        if (requestToken === requestRef.current) setState({ kind: 'error' });
      });
  }

  // The blob outlives this hook's state, so an unmount with a preview on screen would leak it.
  useEffect(() => {
    return () => {
      ++requestRef.current;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  return { state, show, clear };
}
