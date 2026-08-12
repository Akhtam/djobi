import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPipelineRun,
  patchPipelineRun,
  storageKey as tabStorageKey,
  type PipelineRunState,
  type PipelineStatus,
  type TabState,
} from '../lib/tabStore';

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
 * Ownership is deliberately lopsided: **the background service worker owns the run's progress**
 * (status, Analysis Step results, failure, fill counts) and this owns only what the user types.
 * Writing status back from here would let an optimistic value land after the background's real
 * result and overwrite it, losing a completed analysis.
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
  /** Whether the initial read for the current tab has completed. */
  hydrated: boolean;
  /**
   * Shows `status` immediately, until the store next speaks.
   *
   * For the gap between a click and the background writing its own status — without it the UI sits
   * unchanged long enough for the user to click twice. Never persisted.
   */
  begin: (status: PipelineStatus) => void;
  /** Persists the user's edits, updating `run` immediately so typing stays responsive. */
  edit: (edits: Pick<PipelineRunState, 'answers' | 'jobDescription'>) => void;
}

/** The subset this hook is allowed to write — see the ownership note on {@link PipelineRunHandle}. */
function editsOf(run: PipelineRunState): Pick<PipelineRunState, 'answers' | 'jobDescription'> {
  return { answers: run.answers, jobDescription: run.jobDescription };
}

export function usePipelineRun(tabId: number | null): PipelineRunHandle {
  const [run, setRun] = useState<PipelineRunState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState<PipelineStatus | null>(null);

  // The edits last persisted, serialized. Storage echoes every write back through `onChanged`,
  // including this hook's own; without this the echo would be applied and written straight back out.
  const lastSyncedEditsRef = useRef<string | null>(null);

  useEffect(() => {
    if (tabId === null) return;

    let current = true;
    setHydrated(false);
    setRun(null);
    setPending(null);
    lastSyncedEditsRef.current = null;

    void getPipelineRun(tabId).then((stored) => {
      // A tab switch mid-read must not apply the previous tab's run over the new one.
      if (!current) return;
      if (stored) lastSyncedEditsRef.current = JSON.stringify(editsOf(stored));
      setRun(stored);
      setHydrated(true);
    });

    return () => {
      current = false;
    };
  }, [tabId]);

  // Keeps the run live as `background/applicationPipeline.ts` checkpoints progress into the store.
  useEffect(() => {
    if (tabId === null) return;
    const key = tabStorageKey(tabId);

    function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName !== 'session' || !(key in changes)) return;

      const incoming = (changes[key].newValue as TabState | undefined)?.run;
      if (!incoming) return; // no run yet, or the tab's entry was cleared — nothing to reflect

      lastSyncedEditsRef.current = JSON.stringify(editsOf(incoming));
      setRun(incoming);
      // The store has spoken, so the optimistic status has served its purpose — stand it down here,
      // where the update actually arrives. Doing this by comparing statuses instead would not work:
      // a second Fill Step returns the run to the status it already had, so the value alone can't
      // distinguish "the background has answered" from "nothing has happened yet". That is the
      // whole reason a counter used to be exported.
      setPending(null);
    }

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [tabId]);

  const edit = useCallback(
    (edits: Pick<PipelineRunState, 'answers' | 'jobDescription'>) => {
      if (tabId === null) return;

      // Apply locally first so a controlled textarea doesn't lag a storage round-trip.
      setRun((prev) => (prev ? { ...prev, ...edits } : prev));

      const serialized = JSON.stringify(edits);
      if (serialized === lastSyncedEditsRef.current) return;
      lastSyncedEditsRef.current = serialized;
      void patchPipelineRun(tabId, edits);
    },
    [tabId],
  );

  const begin = useCallback((status: PipelineStatus) => setPending(status), []);

  return { run, status: pending ?? run?.status ?? null, hydrated, begin, edit };
}
