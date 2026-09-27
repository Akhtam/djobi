import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  type PipelineFailure,
  type PipelineRunState,
  type PipelineStatus,
  type RunStep,
  isBusy,
} from '../lib/run';
import { notify } from '../lib/messages';
import { createRunView, NO_RUN_VIEW, type RunEdits } from './runView';

/** How often an in-progress run is checked on (one message, no storage read). */
const RUN_CHECK_MS = 15_000;

/**
 * One tab's pipeline run kept in sync with the store, plus the status the panel renders. The
 * reconciliation is `panel/runView.ts`'s; this hook gives each tab and scope a view, applies
 * `accepts`, and checks on steps whose worker may have died. The header pill and the Autofill body
 * both render its result.
 */
export interface PipelineRunHandle {
  /** The stored run, or `null` when none exists or it isn't one this caller `accepts`. */
  run: PipelineRunState | null;
  /**
   * What to render: a delivery failure first, then an optimistic status, then the stored run's;
   * `null` before any analysis.
   */
  status: PipelineStatus | null;
  /**
   * Why the current step failed (delivery failure, else the run's checkpointed cause), always
   * paired with `status`.
   */
  failure: PipelineFailure | null;
  /**
   * Raises `step`'s running status now (covering the gap before the background writes its own) and
   * returns **that attempt's** callback to stand it down as a delivery failure — an undelivered
   * START or refused claim writes nothing, so without it the tab would spin forever. See
   * `panel/runView.ts`.
   */
  beginCommand: (step: RunStep) => () => void;
  /**
   * Persists the user's edits, updating `run` at once. `tailoredResume` is omitted unless edited,
   * so keystrokes don't resend it. If the store refuses (a save in flight), the edit is dropped and
   * the run re-read.
   */
  edit: (edits: RunEdits) => void;
}

function runViewFor(tabId: number | null) {
  return tabId === null ? NO_RUN_VIEW : createRunView(tabId);
}

/**
 * @param accepts - Whether a stored run is one this caller shows (default: all). Applied to the run
 *   only, so this panel's optimistic status and delivery failure survive a rejected run.
 */
export function usePipelineRun(
  tabId: number | null,
  scopeToken: unknown = tabId,
  accepts: (run: PipelineRunState) => boolean = () => true,
): PipelineRunHandle {
  // The view is stateful (pending edits, optimistic status, attempt counter), so it lives in state,
  // not `useMemo`, which React may discard. A new scope swaps in a fresh view during this render
  // (React's "adjust state on prop change" pattern). `scopeToken` is the key, unread by the factory;
  // an unstarted view holds no resources.
  const [scoped, setScoped] = useState(() => ({ tabId, scopeToken, view: runViewFor(tabId) }));
  let view = scoped.view;
  if (!Object.is(scoped.tabId, tabId) || !Object.is(scoped.scopeToken, scopeToken)) {
    view = runViewFor(tabId);
    setScoped({ tabId, scopeToken, view });
  }
  useEffect(() => view.start(), [view]);
  const { run, pending, dispatch } = useSyncExternalStore(view.subscribe, view.snapshot);

  // The *stored* status, not the reconciled one the caller renders: an optimistic status stands for
  // a step this panel has only just requested, which is not yet something that can be interrupted.
  const storedStatus = run?.status ?? null;

  // Unsticks a run whose worker died: while a step claims to be running, send `CHECK_RUN`. A live
  // worker no-ops; otherwise the message starts one, whose recovery sweep repairs the run and the
  // write arrives through the subscription. (`lib/keepAlive.ts` makes this rare.)
  useEffect(() => {
    if (tabId === null) return;
    if (!isBusy(storedStatus)) return;

    const interval = setInterval(() => notify({ type: 'CHECK_RUN', tabId }), RUN_CHECK_MS);
    return () => clearInterval(interval);
  }, [storedStatus, tabId]);

  const visibleRun = run && accepts(run) ? run : null;
  return {
    run: visibleRun,
    status: dispatch?.status ?? pending ?? visibleRun?.status ?? null,
    failure: dispatch?.failure ?? visibleRun?.failure ?? null,
    beginCommand: view.beginCommand,
    edit: view.edit,
  };
}
