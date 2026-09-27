/**
 * The on-demand Tailored Resume preview: renders the PDF, exposes a `blob:` URL, and revokes each
 * URL exactly once (on a new preview, a page change or unmount), never installing a stale request's
 * result. Kept out of the persisted run: display-only and expensive.
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
 * @param client - Only `renderResumePdf` is used.
 * @param profile - Rendered into the PDF's header and education.
 * @param tailoredResume - What to render; `null` before analysis, when `show` does nothing.
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
        // Re-check after creating the URL: if the request went stale meanwhile, revoke it.
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
