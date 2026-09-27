/**
 * Where a pipeline run has got to, and what may be done from there — one table, with every
 * status set (fillable, reviewable, editable, …) *derived* from it so they can't drift.
 * `status.test.ts` pins the derived sets. The bottom of the run domain (see `lib/run/index.ts`).
 */

export type PipelineStatus =
  | 'analyzing'
  | 'analyze-error'
  | 'duplicate'
  | 'review'
  | 'filling'
  | 'fill-error'
  | 'filled'
  | 'saving'
  | 'save-error'
  | 'saved';
// Excludes panel-local bootstrap states ('loading', 'no-profile', 'ready'); a null run means ready.

/** The step a command starts — the unit a failure is reported against. */
export type RunStep = 'analysis' | 'fill' | 'save';

/** What one status says about the run; each fact is independent, so all are stated per row. */
interface StatusFacts {
  /**
   * A step is in flight. The run is the extension's until it lands, not the candidate's to act on.
   */
  busy: boolean;
  /** The Analysis Step produced something: there is a resume, answers and a form to review. */
  reviewable: boolean;
  /** The Fill Step has completed at least once, so there is an outcome to report and to save. */
  filled: boolean;
  /** That fill has been written to an Application. Saving again would record nothing new. */
  recorded: boolean;
  /** Candidate edits are safe; Save alone locks the snapshot it is writing. */
  editable: boolean;
}

const FACTS: Record<PipelineStatus, StatusFacts> = {
  analyzing: { busy: true, reviewable: false, filled: false, recorded: false, editable: true },
  'analyze-error': {
    busy: false,
    reviewable: false,
    filled: false,
    recorded: false,
    editable: true,
  },
  // Not an error — the run did exactly what it should have, and stopped before spending anything.
  duplicate: { busy: false, reviewable: false, filled: false, recorded: false, editable: true },
  review: { busy: false, reviewable: true, filled: false, recorded: false, editable: true },
  filling: { busy: true, reviewable: true, filled: false, recorded: false, editable: true },
  'fill-error': { busy: false, reviewable: true, filled: false, recorded: false, editable: true },
  filled: { busy: false, reviewable: true, filled: true, recorded: false, editable: true },
  saving: { busy: true, reviewable: true, filled: true, recorded: false, editable: false },
  'save-error': { busy: false, reviewable: true, filled: true, recorded: false, editable: true },
  saved: { busy: false, reviewable: true, filled: true, recorded: true, editable: true },
};

/** Every status, in progression order. The one place the set is enumerated. */
export const PIPELINE_STATUSES = Object.keys(FACTS) as readonly PipelineStatus[];

/** A step is in flight — used to disable the controls that would start another. */
export function isBusy(status: PipelineStatus | null): boolean {
  return status !== null && FACTS[status].busy;
}

/** There is an analysis to show: the resume, the answers and the detected form. */
export function canReview(status: PipelineStatus | null): boolean {
  return status !== null && FACTS[status].reviewable;
}

/** A Fill Step has completed, so the run has an outcome worth reporting. */
export function hasFilled(status: PipelineStatus | null): boolean {
  return status !== null && FACTS[status].filled;
}

/**
 * A fill not yet recorded as an Application — shows the Save button. Editing an answer after saving
 * takes `saved` back to `filled`.
 */
export function hasUnsavedFill(status: PipelineStatus | null): boolean {
  return status !== null && FACTS[status].filled && !FACTS[status].recorded;
}

/** Fill may start only from an idle run whose analysis remains reviewable. */
export function canFill(status: PipelineStatus | null): boolean {
  return canReview(status) && !isBusy(status);
}

/** Save may start only from an idle fill that has not already been recorded. */
export function canSave(status: PipelineStatus | null): boolean {
  return hasUnsavedFill(status) && !isBusy(status);
}

/** Save locks the snapshot it is writing; other steps leave candidate edits available. */
export function canEditRun(status: PipelineStatus | null): boolean {
  return status === null || FACTS[status].editable;
}

/** Whether editing should take a recorded run back to its filled state. */
export function hasRecordedFill(status: PipelineStatus | null): boolean {
  return status !== null && FACTS[status].recorded;
}

const START_RULES: Record<RunStep, (status: PipelineStatus | null) => boolean> = {
  analysis: () => true,
  fill: canFill,
  save: canSave,
};

/**
 * Whether `step` may start from `status` — the whole transition policy.
 *
 * - **Analysis**: from anywhere; it mints a new run.
 * - **Fill**: needs an analysis and an idle run (no fill/save in flight). Re-filling from `filled`
 *   or `saved` is allowed; saves update the same record.
 * - **Save**: needs an unrecorded fill and an idle run.
 */
export function canStart(step: RunStep, status: PipelineStatus | null): boolean {
  return START_RULES[step](status);
}

/**
 * The statuses `step` may start from, derived from {@link canStart} for the claim's
 * compare-and-set.
 */
export function startableFrom(step: RunStep): readonly PipelineStatus[] {
  return PIPELINE_STATUSES.filter((status) => canStart(step, status));
}

/** Each step's running and failure statuses, named once. */
export const STEP_STATUS = {
  analysis: { running: 'analyzing', succeeded: 'review', failed: 'analyze-error' },
  fill: { running: 'filling', succeeded: 'filled', failed: 'fill-error' },
  save: { running: 'saving', succeeded: 'saved', failed: 'save-error' },
} as const satisfies Record<
  RunStep,
  Readonly<{
    running: PipelineStatus;
    succeeded: PipelineStatus;
    failed: 'analyze-error' | 'fill-error' | 'save-error';
  }>
>;
