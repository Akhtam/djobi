/**
 * Where an Application Pipeline run has got to, and what may be done to it there.
 *
 * One table, and every question about a status answered from it. The three sets that used to state
 * this independently were kept in agreement by prose:
 *
 * - `background/applicationPipeline.ts` held `FILLABLE_FROM`, five statuses a Fill Step may start
 *   from, documented as "`reviewOf`'s `canReview` set minus the two it disables the button for".
 * - `lib/runReview.ts` held `canReview`, seven statuses, as a `switch` returning a boolean.
 * - `panel/AutofillTab.tsx` disabled the Fill button on `status === 'filling' || status === 'saving'`
 *   — the "two" that sentence refers to — and named statuses by hand in six more places.
 *
 * The relationship was real and it held, but nothing failed if it stopped holding: adding a status
 * meant finding all three, and the compiler could ask for exactly one of them. Here the sets are
 * *derived* from what each status means, so they cannot drift, and `status.test.ts` asserts the
 * relationship the comment used to assert.
 *
 * This module is the bottom of the run domain: it knows what a status is and nothing about storage,
 * messaging or rendering. See `lib/run/index.ts` for the layering.
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
// Deliberately excludes 'loading'/'no-profile'/'ready' — those are panel-local bootstrap state
// (has a profile loaded yet, has an active tab been found yet), not Application Pipeline progress.
// A null `run` means "ready".

/** The step a command starts — the unit a failure is reported against. */
export type RunStep = 'analysis' | 'fill' | 'save';

/**
 * What one status says about the run, in the terms everything else is derived from.
 *
 * Each is independent of the others — none can be computed from the rest — which is why all four
 * are stated per row rather than half of them being written as a rule. `status.test.ts` checks
 * that the derived sets still come out as the sets the pipeline and the panel used to hold.
 */
interface StatusFacts {
  /** A step is in flight. The run is the extension's until it lands, not the candidate's to act on. */
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
 * There is a fill that has not been recorded as an Application.
 *
 * What puts the Save button on screen. It goes away on `saved` and comes back when the candidate
 * edits an answer, because that takes the run from `saved` to `filled` — a record whose answers
 * have changed is no longer the record that was saved.
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
 * Whether `step` may start from `status` — the pipeline's whole transition policy.
 *
 * **Analysis** starts from anywhere. It is the only step that mints a run, and it replaces whatever
 * the tab held; a re-analysis of a failed, filled or saved run is an ordinary thing to want.
 *
 * **Fill** needs an analysis to fill from and needs the run idle. Requiring an analysis is not
 * enough on its own: a `START_FILL` arriving while a fill or a save was in flight — a duplicated
 * command, or one dispatched out of sequence — would otherwise start a second Fill Step against the
 * same tab. Re-filling from `filled` and `saved` is deliberate: a candidate may re-fill after
 * editing an answer, and the Save Step updates the same record rather than creating a second.
 *
 * **Save** needs a fill that is not already recorded, and the run idle. `saved` is excluded because
 * saving again would write the same snapshot back.
 */
export function canStart(step: RunStep, status: PipelineStatus | null): boolean {
  return START_RULES[step](status);
}

/**
 * The statuses `step` may start from, for `transitionPipelineRun`'s compare-and-set.
 *
 * Derived from {@link canStart} rather than listed, so the array a claim is made with and the
 * predicate a button is disabled by cannot disagree.
 */
export function startableFrom(step: RunStep): readonly PipelineStatus[] {
  return PIPELINE_STATUSES.filter((status) => canStart(step, status));
}

/**
 * What each step's status is called while it runs, and when it fails.
 *
 * One statement of a pairing that used to be spelled out wherever a step was started or reported:
 * the panel wrote `begin('filling')` beside `fail('fill-error', { step: 'fill' })` three times, and
 * the background wrote the error half again. Nine independent facts, correct only by inspection —
 * nothing stopped `filling` being raised beside a `save-error`. Here a step names one row.
 */
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
