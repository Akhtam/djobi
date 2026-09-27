/**
 * The pipeline run for the job the panel is showing: composes `useActiveTab` and `usePipelineRun`
 * and applies the rule that needs both — another job's run isn't this job's, while another route of
 * the same job keeps it. The Autofill and Ask tabs both read this one value.
 */
import type { QuestionAnswer, TailoredResume } from '@djobi/shared';
import { useActiveTab } from './useActiveTab';
import { usePipelineRun } from './usePipelineRun';
import type { RunEdits } from './runView';
import type { PipelineRunState, PipelineStatus, RunStep } from '../lib/run';
import { canEditRun, reviewOf, type RunReview } from '../lib/run';
import { isSameJobUrl, jobKeyForUrl } from '../lib/jobContext';

export interface ActiveRun {
  /** The tracked tab, or `null` before Chrome has named one. */
  tabId: number | null;
  tabUrl: string | null;
  /** Increments whenever the tracked page changes — a different tab, or a navigation within one. */
  changeToken: number;
  /** The stored run **for the job now being shown**, or `null` when there is none. */
  run: PipelineRunState | null;
  /** What to render: the run's status, or `null` before anything has been analyzed on this page. */
  status: PipelineStatus | null;
  /**
   * The one reading of this run (from the reconciled `status`/`failure`), used by both the header
   * pill and the Autofill Tab body so they agree.
   */
  review: RunReview;
  /**
   * Raises a step's running status; returns that attempt's stand-down. Use via
   * `panel/pipelineCommands.ts`.
   */
  beginCommand: (step: RunStep) => () => void;
  /** Persists the candidate's edits to the run. */
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

/**
 * Tracks the active tab's run.
 *
 * @param enabled - Tracking waits until true (the panel has nothing to act with before a Profile).
 */
export function useActiveRun(enabled: boolean): ActiveRun {
  const { tabId, tabUrl, changeToken } = useActiveTab(enabled);
  const jobScope = `${tabId ?? 'none'}:${jobKeyForUrl(tabUrl) ?? tabUrl ?? 'unknown'}`;
  // Navigation updates the URL before the worker's storage cleanup lands; never render another
  // job's run in that gap. Passed as `accepts` (not applied to the result) so this panel's own
  // optimistic status and delivery failure survive the filter.
  const { run, status, failure, beginCommand, edit } = usePipelineRun(
    tabId,
    jobScope,
    (candidate) => isSameJobUrl(candidate.tabUrl, tabUrl),
  );
  // `failure` goes with `status`: a delivery failure is never on the stored run.
  const review = reviewOf(run, status, failure);

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
