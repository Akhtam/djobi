import type { DetectedField } from '@djobi/shared';
import type {
  DuplicateApplication,
  FillOutcome,
  PipelineFailure,
  PipelineRunState,
  RunFailureKind,
} from './state';
import { canReview, type PipelineStatus } from './status';

export type { FillOutcome } from './state';

/**
 * What an Application Pipeline run means to the person watching it, derived once for the panel.
 */

/**
 * How the Fill Step went — which `status` alone can't say (`'filled'` includes writing nothing).
 *
 * `'no-fields-detected'` (the page was never read — reload) and `'nothing-filled'` (the form was
 * read but rejected every value — reloading won't help) are separate because the fixes are
 * opposite. `'unverified'`: no frame answered, so counts are attempts; never treat it as success.
 */

/** The header pill: what it says, and how it should look. */
export interface StatusPill {
  label: string;
  tone: 'busy' | 'success' | 'error';
}

/**
 * The recovery a Run Notice offers, as an identifier (not a callback) so `reviewOf` stays pure.
 */
export type RunNoticeAction = 'analyze-anyway' | 'retry-analysis' | 'retry-fill' | 'retry-save';

/**
 * One **Run Notice** — something a run must tell the candidate; never stored (unlike an
 * Application's Note). Each member carries only what its copy interpolates; the wording lives in
 * `panel/AutofillTab.tsx`.
 *
 * `slot`: `'outcome'` reports how the run went, above the review; `'inline'` reports a failed step
 * to retry, beside the answers.
 */
export type RunNotice =
  | {
      kind: 'duplicate';
      slot: 'outcome';
      tone: 'error';
      action: 'analyze-anyway';
      duplicate: DuplicateApplication;
    }
  | {
      kind: 'analyze-failed';
      slot: 'outcome';
      tone: 'error';
      action: 'retry-analysis';
      reason: RunFailureKind;
    }
  | { kind: 'fill-unverified'; slot: 'outcome'; tone: 'error' }
  | { kind: 'no-fields-detected'; slot: 'outcome'; tone: 'error' }
  | {
      kind: 'nothing-filled';
      slot: 'outcome';
      tone: 'error';
      /** What the run's own re-scan saw — what separates this from `no-fields-detected`. */
      detectedFieldCount: number;
    }
  | { kind: 'fill-complete'; slot: 'outcome'; tone: 'success'; filledFieldCount: number }
  | {
      kind: 'fill-incomplete';
      slot: 'outcome';
      tone: 'error';
      unresolvedRequiredFields: DetectedField[];
    }
  | { kind: 'saved'; slot: 'outcome'; tone: 'success' }
  | {
      kind: 'fill-failed';
      slot: 'inline';
      tone: 'error';
      action: 'retry-fill';
      reason: RunFailureKind;
    }
  | {
      kind: 'save-failed';
      slot: 'inline';
      tone: 'error';
      action: 'retry-save';
      reason: RunFailureKind;
    };

export interface RunReview {
  /** The pill to show, or `null` when the run warrants none. */
  pill: StatusPill | null;
  /**
   * Whether the review (answers, description, resume) stays on screen — including after `'filled'`,
   * since the candidate often needs to edit and re-fill.
   */
  canReview: boolean;
  /** How the Fill Step went, or `null` if it hasn't completed. */
  outcome: FillOutcome | null;
  /**
   * Every notice, in render order. Several can stand at once (saved *and* unresolved fields); only
   * `fill-complete` is superseded by `saved`.
   */
  notices: RunNotice[];
}

/**
 * The review with nothing to show — no run yet, or one that has produced nothing worth reporting.
 */
const IDLE: Omit<RunReview, 'notices'> = { pill: null, canReview: false, outcome: null };

const OUTCOME_PILL: Record<FillOutcome, StatusPill> = {
  unverified: { label: 'Fill unverified', tone: 'error' },
  'no-fields-detected': { label: 'No form found', tone: 'error' },
  'nothing-filled': { label: 'Nothing filled', tone: 'error' },
  incomplete: { label: 'Incomplete', tone: 'error' },
  complete: { label: 'Done', tone: 'success' },
};

/**
 * The reading for `run` under the *reconciled* status (optimistic or delivery-failure status first;
 * see `panel/usePipelineRun.ts`), so pill, body and footer agree. The idle guard is on `status`,
 * since the first Analyze is optimistic before any run exists. `run` supplies only `fillOutcome`.
 */
function readingOf(
  run: PipelineRunState | null,
  status: PipelineStatus | null,
): Omit<RunReview, 'notices'> {
  if (!status) return IDLE;

  // From the status table, the same fact the Fill Step starts from.
  const reviewable = canReview(status);

  switch (status) {
    case 'analyzing':
      return { pill: { label: 'Analyzing…', tone: 'busy' }, canReview: reviewable, outcome: null };

    case 'analyze-error':
      return { pill: { label: 'Error', tone: 'error' }, canReview: reviewable, outcome: null };

    // Not an error — the run did exactly what it should have. The pill says what happened; the
    // panel's own branch offers the way past it.
    case 'duplicate':
      return {
        pill: { label: 'Already applied', tone: 'error' },
        canReview: reviewable,
        outcome: null,
      };

    case 'review':
      return {
        pill: { label: 'Ready to fill', tone: 'success' },
        canReview: reviewable,
        outcome: null,
      };

    case 'filling':
      return { pill: { label: 'Filling…', tone: 'busy' }, canReview: reviewable, outcome: null };

    case 'fill-error':
      return { pill: { label: 'Error', tone: 'error' }, canReview: reviewable, outcome: null };

    case 'filled':
    case 'saving':
    case 'save-error':
    case 'saved': {
      // Fallback keeps a malformed run or pre-run optimistic status from producing a blank pill.
      const outcome = run?.fillOutcome ?? 'unverified';
      const pill =
        status === 'saving'
          ? { label: 'Saving…', tone: 'busy' as const }
          : status === 'save-error'
            ? { label: 'Save failed', tone: 'error' as const }
            : status === 'saved'
              ? { label: 'Saved', tone: 'success' as const }
              : OUTCOME_PILL[outcome];
      return { pill, canReview: reviewable, outcome };
    }
  }
}

/** The Run Notice for one completed Fill Step, carrying whatever its copy has to interpolate. */
function outcomeNotice(run: PipelineRunState | null, outcome: FillOutcome): RunNotice {
  switch (outcome) {
    case 'unverified':
      return { kind: 'fill-unverified', slot: 'outcome', tone: 'error' };
    case 'no-fields-detected':
      return { kind: 'no-fields-detected', slot: 'outcome', tone: 'error' };
    case 'nothing-filled':
      return {
        kind: 'nothing-filled',
        slot: 'outcome',
        tone: 'error',
        // The run's own checkpointed re-scan, not panel-side detection: this number is about the
        // fill that happened, and it is the whole of what distinguishes this from a page never
        // found.
        detectedFieldCount: run?.jobPageData.fields.length ?? 0,
      };
    case 'complete':
      return {
        kind: 'fill-complete',
        slot: 'outcome',
        tone: 'success',
        filledFieldCount: run?.filledFieldCount ?? 0,
      };
    case 'incomplete':
      return {
        kind: 'fill-incomplete',
        slot: 'outcome',
        tone: 'error',
        unresolvedRequiredFields: run?.unresolvedRequiredFields ?? [],
      };
  }
}

/**
 * Every notice for `run`, in render order. `failure` is passed in (not read off `run`) because the
 * panel reconciles a delivery failure ahead of the checkpointed one.
 */
function noticesFor(
  run: PipelineRunState | null,
  status: PipelineStatus | null,
  failure: PipelineFailure | null,
  outcome: FillOutcome | null,
): RunNotice[] {
  const reason = failure?.kind ?? 'unknown';

  // A guard the run did not get past. Each ends the run where it stands, so none of them can be
  // accompanied by a fill outcome.
  if (status === 'duplicate') {
    // No past application, no notice: a duplicate guard with nothing to name has nothing to say,
    // and the payload is what makes that unrepresentable rather than a guard to remember.
    return run?.duplicateOf
      ? [
          {
            kind: 'duplicate',
            slot: 'outcome',
            tone: 'error',
            action: 'analyze-anyway',
            duplicate: run.duplicateOf,
          },
        ]
      : [];
  }

  if (status === 'analyze-error') {
    return [
      { kind: 'analyze-failed', slot: 'outcome', tone: 'error', action: 'retry-analysis', reason },
    ];
  }

  if (status === 'fill-error') {
    return [{ kind: 'fill-failed', slot: 'inline', tone: 'error', action: 'retry-fill', reason }];
  }

  if (!outcome) return [];

  const notices: RunNotice[] = [];

  // Saving supersedes only `fill-complete`; unresolved required fields still need the candidate.
  if (!(status === 'saved' && outcome === 'complete')) notices.push(outcomeNotice(run, outcome));
  if (status === 'saved') notices.push({ kind: 'saved', slot: 'outcome', tone: 'success' });
  if (status === 'save-error') {
    notices.push({
      kind: 'save-failed',
      slot: 'inline',
      tone: 'error',
      action: 'retry-save',
      reason,
    });
  }

  return notices;
}

/**
 * Everything the panel needs to render `run`: pill, whether a review stands, fill outcome, and
 * every Run Notice.
 *
 * @param status - The *reconciled* status; see {@link readingOf}.
 * @param failure - The reconciled cause that goes with `status`; see {@link noticesFor}.
 */
export function reviewOf(
  run: PipelineRunState | null,
  status: PipelineStatus | null,
  failure: PipelineFailure | null,
): RunReview {
  const reading = readingOf(run, status);
  return { ...reading, notices: noticesFor(run, status, failure, reading.outcome) };
}
