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
import type { QuestionAnswer } from '@djobi/shared';
import { useActiveTab } from './useActiveTab';
import { usePipelineRun } from './usePipelineRun';
import type { PipelineFailure, PipelineRunState, PipelineStatus } from '../lib/tabStore';
import { reviewOf, type RunReview } from '../lib/runReview';
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
  /** Shows `status` immediately, for the gap between a click and the background's own write. */
  begin: (status: PipelineStatus) => void;
  /** Stands `begin` back down when Chrome couldn't deliver the command it was raised for. */
  fail: (status: 'analyze-error' | 'fill-error' | 'save-error', failure: PipelineFailure) => void;
  /** Persists the candidate's edits to the run. */
  edit: (
    edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & { status?: 'filled' },
  ) => void;
  /**
   * Rewrites one drafted Question Answer.
   *
   * An operation rather than something each caller assembles from `edit`, because two of them do
   * it — the Autofill Tab's question card and the Ask Tab's "Use this answer" — and both have to
   * apply the same two rules: refuse while a save is in flight, and take a `saved` run back to
   * `filled`, since a record whose answers have changed is no longer the record that was saved.
   */
  updateAnswer: (fieldId: string, answer: string) => void;
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
  const { run, status, failure, begin, fail, edit } = usePipelineRun(tabId, jobScope, (candidate) =>
    isSameJobUrl(candidate.tabUrl, tabUrl),
  );
  // `failure` is handed over with `status`: the two describe the same failure, and a delivery
  // failure this panel is holding is never on the stored run. Reading the cause off the run instead
  // is how a Run Notice came to name the previous step's error, or none at all.
  const review = reviewOf(run, status, failure);

  function updateAnswer(fieldId: string, answer: string) {
    if (!run || status === 'saving') return;

    const answers: QuestionAnswer[] = run.answers.map((existing) =>
      existing.fieldId === fieldId ? { ...existing, answer } : existing,
    );
    edit({
      answers,
      jobDescription: run.jobDescription,
      ...(status === 'saved' ? { status: 'filled' as const } : {}),
    });
  }

  return {
    tabId,
    tabUrl,
    changeToken,
    run,
    status,
    review,
    begin,
    fail,
    edit,
    updateAnswer,
  };
}
