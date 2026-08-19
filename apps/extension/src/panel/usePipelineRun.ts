import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPipelineRun,
  storageKey as tabStorageKey,
  type PipelineRunState,
  type PipelineStatus,
  type TabState,
} from '../lib/tabStore';
import { notify } from '../lib/messages';

/**
 * Keeps one tab's Application Pipeline run in sync with `lib/tabStore.ts`, and owns the status the
 * panel renders.
 *
 * The panel used to hold each of the run's fields in its own `useState` and reassemble them by hand
 * in three places — the initial read, the write-back, and the storage subscription. Every one of
 * those had to list every field, so adding a single field to the run meant ten edits across five
 * files, and omitting one of the three sites still compiled. Here the run moves as one value and a
 * new field costs nothing.
 *
 * Ownership is deliberately lopsided: **the background service worker serializes every persisted
 * mutation and owns operational progress** (Analysis results, failures and fill counts). This hook
 * owns optimistic typed edits and may request the associated `saved` → `filled` reset, but never
 * writes storage directly.
 *
 * `status` is nonetheless computed here rather than in the component, because it is assembled from
 * three sources — the stored run, an optimistic value, and the fact that a store update has arrived
 * — and only two of those are the component's business. Keeping the third out of the interface is
 * what removed `syncedAt`: a counter the panel had to receive and hang a `useEffect` on purely so
 * an optimistic status knew when to stand down. See {@link begin}.
 */
export interface PipelineRunHandle {
  /** The stored run for this tab, or `null` when nothing has been analyzed on it yet. */
  run: PipelineRunState | null;
  /**
   * What the panel should render: the optimistic status while one is standing, the stored run's
   * otherwise, and `null` before anything has been analyzed on this tab.
   */
  status: PipelineStatus | null;
  /**
   * Whether the initial read for the current tab has completed.
   *
   * The panel doesn't render this — it renders `run` and `status`, both of which read as "nothing
   * yet" until the read lands, so it has nothing to wait for. It is here for tests, which need a
   * precise barrier to await before asserting: without it they would have to wait on the *effect*
   * of hydration and would pass or fail on timing. An affordance that exists only for the test
   * surface is still part of the interface, so it's stated rather than quietly present.
   */
  hydrated: boolean;
  /**
   * Shows `status` immediately, until the store next speaks.
   *
   * For the gap between a click and the background writing its own status — without it the UI sits
   * unchanged long enough for the user to click twice. Never persisted.
   */
  begin: (status: PipelineStatus) => void;
  /** Persists the user's edits, updating `run` immediately so typing stays responsive. */
  edit: (
    edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & { status?: 'filled' },
  ) => void;
}

/** The subset this hook is allowed to write — see the ownership note on {@link PipelineRunHandle}. */
function editsOf(run: PipelineRunState): Pick<PipelineRunState, 'answers' | 'jobDescription'> {
  return { answers: run.answers, jobDescription: run.jobDescription };
}

export function usePipelineRun(
  tabId: number | null,
  scopeToken: unknown = tabId,
): PipelineRunHandle {
  const [run, setRun] = useState<PipelineRunState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState<PipelineStatus | null>(null);
  const scopeTokenRef = useRef(scopeToken);
  // Advances whenever a store event supersedes the snapshot captured by an in-flight initial read.
  const revisionRef = useRef(0);

  // The edits last persisted, serialized. Storage echoes every write back through `onChanged`,
  // including this hook's own; without this the echo would be applied and written straight back out.
  const lastSyncedEditsRef = useRef<string | null>(null);
  // The newest optimistic edit can be ahead of an older UPDATE_RUN echo in the background queue.
  const pendingEditsRef = useRef<string | null>(null);

  useEffect(() => {
    if (tabId === null) return;

    let current = true;
    const revision = ++revisionRef.current;
    scopeTokenRef.current = scopeToken;
    setHydrated(false);
    setRun(null);
    setPending(null);
    lastSyncedEditsRef.current = null;
    pendingEditsRef.current = null;

    void getPipelineRun(tabId).then((stored) => {
      // A scope change or newer storage event must not let this older snapshot replace live state.
      if (!current || revision !== revisionRef.current) return;
      if (stored) lastSyncedEditsRef.current = JSON.stringify(editsOf(stored));
      setRun(stored);
      setHydrated(true);
    });

    return () => {
      current = false;
    };
  }, [scopeToken, tabId]);

  // Keeps the run live as `background/applicationPipeline.ts` checkpoints progress into the store.
  useEffect(() => {
    if (tabId === null) return;
    const key = tabStorageKey(tabId);

    function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName !== 'session' || !(key in changes)) return;

      ++revisionRef.current;
      const incoming = (changes[key].newValue as TabState | undefined)?.run ?? null;
      const incomingEdits = incoming ? JSON.stringify(editsOf(incoming)) : null;
      const pendingEdits = pendingEditsRef.current;

      setRun((currentRun) => {
        // Preserve a newer local value while an older edit echo works through the background queue.
        if (
          incoming &&
          currentRun?.runId === incoming.runId &&
          pendingEdits !== null &&
          incomingEdits !== pendingEdits
        ) {
          return { ...incoming, ...editsOf(currentRun) };
        }
        return incoming;
      });
      if (incomingEdits === pendingEdits) pendingEditsRef.current = null;
      lastSyncedEditsRef.current = incomingEdits;
      setHydrated(true);
      // The store has spoken, so the optimistic status has served its purpose — stand it down here,
      // where the update actually arrives. Doing this by comparing statuses instead would not work:
      // a second Fill Step returns the run to the status it already had, so the value alone can't
      // distinguish "the background has answered" from "nothing has happened yet". That is the
      // whole reason a counter used to be exported.
      setPending(null);
    }

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [scopeToken, tabId]);

  const edit = useCallback(
    (edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & { status?: 'filled' }) => {
      if (tabId === null || !run) return;

      // Apply locally first so a controlled textarea doesn't lag a storage round-trip.
      setRun((prev) => (prev ? { ...prev, ...edits } : prev));

      const serialized = JSON.stringify({
        answers: edits.answers,
        jobDescription: edits.jobDescription,
      });
      // An undo can equal the last server echo while a different local edit is still pending. It
      // must still be sent, otherwise that older pending edit eventually wins on the server.
      if (
        serialized === lastSyncedEditsRef.current &&
        pendingEditsRef.current === null &&
        edits.status === undefined
      ) {
        return;
      }
      pendingEditsRef.current = serialized;
      notify({ type: 'UPDATE_RUN', tabId, runId: run.runId, updates: edits });
    },
    [run, tabId],
  );

  const begin = useCallback((status: PipelineStatus) => setPending(status), []);

  // Effects reset the state after a scope change; hide it during that render as well.
  const scopeIsCurrent = scopeTokenRef.current === scopeToken;
  const visibleRun = scopeIsCurrent ? run : null;
  return {
    run: visibleRun,
    status: scopeIsCurrent ? (pending ?? visibleRun?.status ?? null) : null,
    hydrated: scopeIsCurrent && hydrated,
    begin,
    edit,
  };
}
