/**
 * The Application Pipeline run's domain, as one module: statuses, transitions, capabilities, the
 * run's shape, and how it reads to the candidate.
 *
 * ```
 *   panel/            projection — labels, notices, which control is disabled
 *   background/       orchestration — effects, claims, checkpoints
 *   lib/tabStore/     store adapter — chrome.storage.session, the per-tab lock
 *   lib/run/          domain — statuses, transitions, capabilities, the run's shape   ← here
 * ```
 *
 * Imports go **down** only: nothing here imports `tabStore/`, `background/` or `panel/` (only the
 * `JobPageData` type from `lib/messages.ts`), so it tests without a `chrome` stub. `reviewOf` is
 * one reconciled reading rather than separate queries, so the header pill and tab body can't
 * disagree.
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
  backgroundProgressOf,
  isRunFailureKind,
  panelEditsOf,
  PANEL_EDITABLE_FIELDS,
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
