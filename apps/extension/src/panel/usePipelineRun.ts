import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPipelineRun,
  patchPipelineRun,
  storageKey as tabStorageKey,
  type PipelineRunState,
  type TabState,
} from '../lib/tabStore';

/**
 * Keeps one tab's Application Pipeline run in sync with `lib/tabStore.ts`.
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
 */
export interface PipelineRunHandle {
  /** The stored run for this tab, or `null` when nothing has been analyzed on it yet. */
  run: PipelineRunState | null;
  /** Whether the initial read for the current tab has completed. */
  hydrated: boolean;
  /**
   * Increments every time an update arrives from storage. Callers showing an optimistic status use
   * it to know the store has spoken and theirs should stand down — a status alone can't tell them,
   * since a second Fill Step returns the run to the status it already had.
   */
  syncedAt: number;
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
  const [syncedAt, setSyncedAt] = useState(0);

  // The edits last persisted, serialized. Storage echoes every write back through `onChanged`,
  // including this hook's own; without this the echo would be applied and written straight back out.
  const lastSyncedEditsRef = useRef<string | null>(null);

  useEffect(() => {
    if (tabId === null) return;

    let current = true;
    setHydrated(false);
    setRun(null);
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
      setSyncedAt((n) => n + 1);
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

  return { run, hydrated, syncedAt, edit };
}
