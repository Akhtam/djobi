/**
 * The pipeline run for the job the panel is showing: the active tab, that tab's stored run kept in
 * sync with the store, this panel's optimistic status and edits, and the rule that needs both tab
 * and run — another job's run isn't this job's, while another route of the same job keeps it. The
 * reconciliation is `panel/runView.ts`'s; the Autofill and Ask tabs both read this one value.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { QuestionAnswer, TailoredResume } from '@djobi/shared';
import { useActiveTab } from './useActiveTab';
import { createRunView, NO_RUN_VIEW, type RunEdits } from './runView';
import type { PipelineRunState, PipelineStatus, RunStep } from '../lib/run';
import { canEditRun, isBusy, reviewOf, type RunReview } from '../lib/run';
import { isSameJobUrl, jobKeyForUrl } from '../lib/jobContext';
import { notify } from '../lib/messages';

/** How often an in-progress run is checked on (one message, no storage read). */
const RUN_CHECK_MS = 15_000;

export interface ActiveRun {
  /** The tracked tab, or `null` before Chrome has named one. */
  tabId: number | null;
  tabUrl: string | null;
  /** Increments whenever the tracked page changes — a different tab, or a navigation within one. */
  changeToken: number;
  /** The stored run **for the job now being shown**, including this panel's unanswered edits. */
  run: PipelineRunState | null;
  /**
   * What to render: a delivery failure first, then an optimistic status, then the run's own;
   * `null` before anything has been analyzed on this page.
   */
  status: PipelineStatus | null;
  /**
   * The one reading of this run (from the reconciled status and failure), used by both the header
   * pill and the Autofill Tab body so they agree.
   */
  review: RunReview;
  /**
   * Raises `step`'s running status now (covering the gap before the background writes its own) and
   * returns **that attempt's** callback to stand it down as a delivery failure — an undelivered
   * START or refused claim writes nothing, so without it the tab would spin forever. Use via
   * `panel/pipelineCommands.ts`.
   */
  beginCommand: (step: RunStep) => () => void;
  /**
   * Persists the candidate's edits, updating `run` at once. `tailoredResume` is omitted unless
   * edited, so keystrokes don't resend it. If the store refuses (a save in flight), the edit is
   * dropped and the run re-read.
   */
  edit: (edits: RunEdits) => void;
  /**
   * Rewrites one drafted answer on run `runId` — refused if this panel no longer shows that run
   * (the store enforces it too, in `applyPanelEdit`). `runId` is explicit because an Ask thread's
   * answer belongs to the run it was seeded from.
   */
  updateAnswer: (runId: string, fieldId: string, answer: string) => void;
  /**
   * Replaces the run's Tailored Resume with the reviewed version (`panel/ResumeReview.tsx`).
   * Refused like {@link updateAnswer}.
   */
  updateTailoredResume: (runId: string, tailoredResume: TailoredResume) => void;
}

function runViewFor(tabId: number | null) {
  return tabId === null ? NO_RUN_VIEW : createRunView(tabId);
}

/**
 * Tracks the active tab's run.
 *
 * @param enabled - Tracking waits until true (the panel has nothing to act with before a Profile).
 */
export function useActiveRun(enabled: boolean): ActiveRun {
  const { tabId, tabUrl, changeToken } = useActiveTab(enabled);
  const jobScope = `${tabId ?? 'none'}:${jobKeyForUrl(tabUrl) ?? tabUrl ?? 'unknown'}`;

  // The view is stateful (pending edits, optimistic status, attempt counter), so it lives in state,
  // not `useMemo`, which React may discard. A new job swaps in a fresh view during this render
  // (React's "adjust state on prop change" pattern), dropping the last job's optimistic status; an
  // unstarted view holds no resources.
  const [scoped, setScoped] = useState(() => ({ jobScope, view: runViewFor(tabId) }));
  let view = scoped.view;
  if (scoped.jobScope !== jobScope) {
    view = runViewFor(tabId);
    setScoped({ jobScope, view });
  }
  useEffect(() => view.start(), [view]);
  const { run: storedRun, pending, dispatch } = useSyncExternalStore(view.subscribe, view.snapshot);

  // Unsticks a run whose worker died: while a step claims to be running, send `CHECK_RUN`. A live
  // worker no-ops; otherwise the message starts one, whose recovery sweep repairs the run and the
  // write arrives through the subscription. (`lib/keepAlive.ts` makes this rare.) Keyed on the
  // *stored* status: an optimistic one stands for a step this panel has only just requested, which
  // can't have been interrupted yet.
  const storedStatus = storedRun?.status ?? null;
  useEffect(() => {
    if (tabId === null) return;
    if (!isBusy(storedStatus)) return;

    const interval = setInterval(() => notify({ type: 'CHECK_RUN', tabId }), RUN_CHECK_MS);
    return () => clearInterval(interval);
  }, [storedStatus, tabId]);

  // Navigation updates the URL before the worker's storage cleanup lands; never render another
  // job's run in that gap. Applied to the run only, so this panel's own optimistic status and
  // delivery failure survive it.
  const run = storedRun && isSameJobUrl(storedRun.tabUrl, tabUrl) ? storedRun : null;
  const status = dispatch?.status ?? pending ?? run?.status ?? null;
  // A delivery failure is never on the stored run, so it goes with `status`.
  const failure = dispatch?.failure ?? run?.failure ?? null;
  const review = reviewOf(run, status, failure);
  const { beginCommand, edit } = view;

  function updateAnswer(runId: string, fieldId: string, answer: string) {
    // Not this panel's run any more: the candidate moved to another tab or re-analyzed between the
    // answer being drafted and it being applied.
    if (!run || run.runId !== runId || !canEditRun(status)) return;

    const answers: QuestionAnswer[] = run.answers.map((existing) =>
      existing.fieldId === fieldId ? { ...existing, answer } : existing,
    );
    edit({ answers, jobDescription: run.jobDescription });
  }

  function updateTailoredResume(runId: string, tailoredResume: TailoredResume) {
    if (!run || run.runId !== runId || !canEditRun(status)) return;

    edit({ answers: run.answers, jobDescription: run.jobDescription, tailoredResume });
  }

  return {
    tabId,
    tabUrl,
    changeToken,
    run,
    status,
    review,
    beginCommand,
    edit,
    updateAnswer,
    updateTailoredResume,
  };
}
