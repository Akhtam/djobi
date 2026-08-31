/**
 * The Application Pipeline run, as one module.
 *
 * A run was a concept spread across ten files and no interface. `PipelineRunState` and the status
 * vocabulary lived in a storage module; the transition policy lived in the background as
 * `FILLABLE_FROM`; whether a review still stood lived in `lib/runReview.ts` as a second list; the
 * panel disabled its buttons from a third set of status literals; and answer resolution lived in
 * `lib/runAnswers.ts`. Each module argued well for itself, and none of them could answer "what may
 * happen to this run now" — so a fourth step meant nine edits, three of which the compiler could not
 * ask for.
 *
 * **The layering, and the rule that keeps this from becoming a run-shaped everything-module:**
 *
 * ```
 *   panel/            projection — labels, notices, which control is disabled
 *   background/       orchestration — effects, claims, checkpoints
 *   lib/tabStore/     store adapter — chrome.storage.session, the per-tab lock
 *   lib/run/          domain — statuses, transitions, capabilities, the run's shape   ← here
 * ```
 *
 * Imports go **down** only. Nothing under `lib/run/` may import from `tabStore/`, `background/` or
 * `panel/`, which is what makes it testable without a `chrome` stub and what stops persistence or
 * wording from accumulating in it. The one import that leaves this directory is the `JobPageData`
 * *type* from `lib/messages.ts` — a plain data shape, no runtime dependency, and nothing imports
 * back the other way.
 *
 * What deliberately stayed out: `reviewOf` is one reconciled reading rather than a set of
 * independent capability queries for the panel. Splitting it is how the header pill and the tab body
 * came to disagree in the first place — see `lib/run/review.ts`. Capability queries answer *what may
 * be done*; the reading answers *what to show*, once.
 */
export {
  PIPELINE_STATUSES,
  STEP_STATUS,
  canEditRun,
  canFill,
  canReview,
  canSave,
  canStart,
  hasFilled,
  hasRecordedFill,
  hasUnsavedFill,
  isBusy,
  startableFrom,
  type PipelineStatus,
  type RunStep,
} from './status';

export {
  asAnalyzedRun,
  isRunFailureKind,
  RUN_FAILURE_KINDS,
  type AnalyzedRun,
  type DuplicateApplication,
  type FillOutcome,
  type PipelineFailure,
  type PipelineRunState,
  type RunFailureKind,
} from './state';

export {
  reviewOf,
  type RunNotice,
  type RunNoticeAction,
  type RunReview,
  type StatusPill,
} from './review';

export { answersFor, type RunAnswers } from './answers';
