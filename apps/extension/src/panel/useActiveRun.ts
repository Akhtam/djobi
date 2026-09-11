/**
 * The Application Pipeline run for the job the panel is currently showing.
 *
 * Composes the two hooks either side of it — `useActiveTab` (which page) and `usePipelineRun`
 * (which run) — and applies the one rule that only makes sense once both are in hand: a run from a
 * different job is not this job's run, while another route for the same job may retain it.
 *
 * That rule used to sit in `panel/App.tsx`, between the two `use…` calls, as three lines with a
 * comment. It is not a rendering concern and it is not optional — every reader of the run has to
 * apply it or risk acting on the previous page's analysis — so it belongs with the hooks it
 * reconciles rather than with whichever module happens to call them.
 *
 * Two tabs read a run: the Autofill Tab renders it, and the Ask Tab writes an answer back into it
 * (and reads its Job Info for grounding). Both go through this one value, so there is one copy of
 * the run in the panel rather than one per tab.
 */
import type { QuestionAnswer, TailoredResume } from '@djobi/shared';
import { useActiveTab } from './useActiveTab';
import { usePipelineRun } from './usePipelineRun';
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
   * The one reading of this run, derived from `status` and `failure` rather than from the stored run.
   *
   * Both readers take it from here: the shell's header pill and the Autofill Tab's own body. They
   * used to derive it separately from `reviewOf(run)`, which is how the pill came to contradict the
   * tab it describes for the length of every click.
   *
   * The reconciled `failure` is deliberately *not* offered alongside it. Its only consumer was the
   * tab's hand-written error copy, which is now a `RunNotice` carrying its own `cause` — and a
   * second way to reach the same message is how the two came to disagree in the first place.
   */
  review: RunReview;
  /**
   * Raises a step's running status immediately and returns that attempt's way to stand it down —
   * see `panel/usePipelineRun.ts`. Bound to the messages it belongs with in
   * `panel/pipelineCommands.ts`, which is what every caller should use.
   */
  beginCommand: (step: RunStep) => (message: string) => void;
  /** Persists the candidate's edits to the run. */
  edit: (
    edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & {
      tailoredResume?: TailoredResume;
    },
  ) => void;
  /**
   * Rewrites one drafted Question Answer, on the run the caller means.
   *
   * An operation rather than something each caller assembles from `edit`, because two of them do
   * it — the Autofill Tab's question card and the Ask Tab's "Use this answer" — and both have to
   * apply the same rule: **refuse a write meant for a run this panel is no longer showing**. The
   * `canEditRun` check alongside it is a cheap local skip, not the correctness guarantee — the
   * store enforces the same rule authoritatively and can still refuse a write this passed, see
   * `lib/tabStore/pipelineRun.ts`'s `applyPanelEdit`.
   *
   * `runId` is a parameter rather than something read from the current run because of that rule.
   * The Ask Tab's answer belongs to the run its thread was seeded from, which may not be the run in
   * front of the candidate by the time they click; checking it only while rendering — which is what
   * the tab did — leaves the click itself unguarded.
   */
  updateAnswer: (runId: string, fieldId: string, answer: string) => void;
  /**
   * Replaces the run's Tailored Resume with the candidate's reviewed version — accepted, edited or
   * reordered bullets from `panel/ResumeReview.tsx`. Same rule as {@link updateAnswer}: refused for
   * a run this panel is no longer showing.
   */
  updateTailoredResume: (runId: string, tailoredResume: TailoredResume) => void;
}

/**
 * Tracks the active tab's run.
 *
 * @param enabled - Tracking doesn't start until this is true, so the panel doesn't chase tabs while
 *   it is still showing its "set up your profile" state and has nothing to act with.
 */
export function useActiveRun(enabled: boolean): ActiveRun {
  const { tabId, tabUrl, changeToken } = useActiveTab(enabled);
  const jobScope = `${tabId ?? 'none'}:${jobKeyForUrl(tabUrl) ?? tabUrl ?? 'unknown'}`;
  // Navigation updates the tracked URL before the service worker's async storage cleanup lands.
  // Never render another job's run in that gap, but retain same-job ATS route transitions.
  //
  // Handed to the hook rather than applied to what it returns, because the run is only one of the
  // four sources its `status` reconciles: an optimistic status and a delivery failure belong to a
  // command *this* panel just sent, and dropping them alongside the stale run is how an undelivered
  // START in that same gap left the panel with no spinner and no error — see the hook's `accepts`.
  const { run, status, failure, beginCommand, edit } = usePipelineRun(
    tabId,
    jobScope,
    (candidate) => isSameJobUrl(candidate.tabUrl, tabUrl),
  );
  // `failure` is handed over with `status`: the two describe the same failure, and a delivery
  // failure this panel is holding is never on the stored run. Reading the cause off the run instead
  // is how a Run Notice came to name the previous step's error, or none at all.
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
