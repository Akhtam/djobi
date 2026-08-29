import type { DetectedField } from '@djobi/shared';
import type {
  DuplicateApplication,
  FillOutcome,
  PipelineFailure,
  PipelineRunState,
  PipelineStatus,
} from './tabStore';

export type { FillOutcome } from './tabStore';

/**
 * What an Application Pipeline run means to the person watching it.
 *
 * This exists because the panel was deriving it six times over. Individual `PipelineStatus` members
 * were named in a pill `switch`, in a four-status `canReview` disjunction, and in four separate
 * render guards; and the three-way reading of how the Fill Step went was written twice — once to
 * label the pill, once to choose between three banners — from the same two numbers. Two derivations
 * of one rule in one file is how they drift.
 *
 * Deriving it here rather than in the panel also puts it next to `PipelineRunState`, so adding a
 * status is one edit in one module instead of six edits the compiler can't ask for.
 */

/**
 * How the Fill Step actually went, which the run's `status` alone cannot say.
 *
 * A run reaches `'filled'` whenever every step "succeeded" — including the case where it was handed
 * no fields at all and therefore wrote nothing. That is a failure wearing a success status, and it
 * reads as success to anything looking only at `status`.
 *
 * `'no-fields-detected'` and `'nothing-filled'` are both "zero fields written", and they were one
 * member until the banner for it had to say something true about both. They are opposite problems:
 * the first is a page this extension never got a look at (an orphaned content script, a form that
 * never rendered), where reloading is the fix; the second is a page whose form was read correctly
 * and then rejected every value written into it, where reloading changes nothing and the field list
 * is what the user needs. Telling someone to reload a page that was detected perfectly well sends
 * them after the wrong problem.
 *
 * `'unverified'` is different again: no frame answered, so counts describe what was attempted, not
 * what the page kept. It must never be reconstructed as success.
 */

/** The header pill: what it says, and how it should look. */
export interface StatusPill {
  label: string;
  tone: 'busy' | 'success' | 'error';
}

/**
 * The recovery a Run Notice offers, named rather than bound.
 *
 * An identity and not a callback, so `reviewOf` stays a pure function of the run: the moment it
 * takes handlers it needs spies to test and grows an argument that changes on every render. The
 * panel maps these onto the three `notify` calls it already has.
 */
export type RunNoticeAction = 'analyze-anyway' | 'retry-analysis' | 'retry-fill' | 'retry-save';

/**
 * One thing a run has to tell the candidate — a **Run Notice**. Not an Application's Note, which is
 * a persisted entry in its interview log; this exists for the length of a run and is never stored.
 *
 * Each member carries exactly what its copy interpolates and nothing else, which is the point:
 * `duplicate` cannot exist without the application it is about, so the panel's hand-written
 * `status === 'duplicate' && duplicateOf` guard becomes structural. The **words** are deliberately
 * not here — "reload the page" versus "fill it in by hand" is a product judgement about not sending
 * someone after the wrong problem, and it belongs beside the JSX a person reads. This module names
 * the situation; `panel/AutofillTab.tsx` says the sentence.
 *
 * `slot` reads like layout and isn't: `'outcome'` is *how the run went*, reported above the review,
 * and `'inline'` is *this step failed, retry it from where you are*, reported beside the answers it
 * would have you re-fill. It is the same axis `canReview` already sits on.
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
      /** The underlying cause, or `null` for a failure that arrived without one. */
      cause: string | null;
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
      cause: string | null;
    }
  | {
      kind: 'save-failed';
      slot: 'inline';
      tone: 'error';
      action: 'retry-save';
      cause: string | null;
    };

export interface RunReview {
  /** The pill to show, or `null` when the run warrants none. */
  pill: StatusPill | null;
  /**
   * Whether to keep the review UI — drafted answers, job-description editor, resume preview — on
   * screen.
   *
   * True for `'filled'` as well as the in-progress states, deliberately: filling a form is rarely
   * the end of the task. The page's own validation may reject a value, a required field may have
   * gone unresolved, or an answer may just read badly once it's sitting in the form. In every one
   * of those cases the user needs the review still in front of them to edit and re-fill. Tearing it
   * down on success left them with a green check and no way back to the content short of re-running
   * the whole Analysis Step.
   */
  canReview: boolean;
  /** How the Fill Step went, or `null` if it hasn't completed. */
  outcome: FillOutcome | null;
  /**
   * Everything this run has to tell the candidate, in render order.
   *
   * A list, not one notice per slot, because two can stand at once: a run saved with required
   * fields still unresolved reports both — saving didn't fill them, and the form is still sitting
   * there unsubmitted. Only `fill-complete` is superseded by `saved`, because "Save the application
   * when you're ready" stops being true the moment it is saved.
   */
  notices: RunNotice[];
}

/** The review with nothing to show — no run yet, or one that has produced nothing worth reporting. */
const IDLE: Omit<RunReview, 'notices'> = { pill: null, canReview: false, outcome: null };

const OUTCOME_PILL: Record<FillOutcome, StatusPill> = {
  unverified: { label: 'Fill unverified', tone: 'error' },
  'no-fields-detected': { label: 'No form found', tone: 'error' },
  'nothing-filled': { label: 'Nothing filled', tone: 'error' },
  incomplete: { label: 'Incomplete', tone: 'error' },
  complete: { label: 'Done', tone: 'success' },
};

/**
 * Everything the panel needs to render `run`, derived once.
 *
 * `status` is the *reconciled* status — an optimistic one while it stands, a delivery failure ahead
 * of that, and the stored run's otherwise (`panel/usePipelineRun.ts` assembles it). Deriving from it
 * rather than from `run.status` is what keeps the header pill, the tab body and the footer saying
 * the same thing: they used to disagree for the whole gap between a click and the background's own
 * write, because the pill read the stored run while the body and footer read the reconciled status.
 *
 * It is therefore separate from `run`, and the idle guard is on `status`, not `run`: the first
 * Analyze on a page raises `'analyzing'` before any run exists to store it, and a pill suppressed on
 * `!run` would stay blank while the body already said "Analyzing…". `run` is consulted only for
 * `fillOutcome`, which no optimistic status can supply.
 *
 * Defaults to the stored status, which is the whole reading for a caller with no optimism to apply.
 */
function readingOf(
  run: PipelineRunState | null,
  status: PipelineStatus | null,
): Omit<RunReview, 'notices'> {
  if (!status) return IDLE;

  switch (status) {
    case 'analyzing':
      return { pill: { label: 'Analyzing…', tone: 'busy' }, canReview: false, outcome: null };

    case 'analyze-error':
      return { pill: { label: 'Error', tone: 'error' }, canReview: false, outcome: null };

    // Not an error — the run did exactly what it should have. The pill says what happened; the
    // panel's own branch offers the way past it.
    case 'duplicate':
      return { pill: { label: 'Already applied', tone: 'error' }, canReview: false, outcome: null };

    case 'review':
      return { pill: { label: 'Ready to fill', tone: 'success' }, canReview: true, outcome: null };

    case 'filling':
      return { pill: { label: 'Filling…', tone: 'busy' }, canReview: true, outcome: null };

    case 'fill-error':
      return { pill: { label: 'Error', tone: 'error' }, canReview: true, outcome: null };

    case 'filled':
    case 'saving':
    case 'save-error':
    case 'saved': {
      // Store reads normalize legacy completed runs to `unverified`; this fallback also keeps a
      // malformed or hand-built run — or an optimistic status standing before any run exists — from
      // becoming a blank pill.
      const outcome = run?.fillOutcome ?? 'unverified';
      const pill =
        status === 'saving'
          ? { label: 'Saving...', tone: 'busy' as const }
          : status === 'save-error'
            ? { label: 'Save failed', tone: 'error' as const }
            : status === 'saved'
              ? { label: 'Saved', tone: 'success' as const }
              : OUTCOME_PILL[outcome];
      return { pill, canReview: true, outcome };
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
        // fill that happened, and it is the whole of what distinguishes this from a page never found.
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
 * What this run has to tell the candidate, in render order.
 *
 * `failure` is taken as an argument rather than read off `run` for the same reason `status` is: the
 * panel reconciles a *delivery* failure — a command Chrome never got to the service worker — ahead
 * of anything the run checkpointed, and `panel/usePipelineRun.ts` is explicit that the two always
 * describe the same failure. Reading the cause from the run here would re-split that pair one layer
 * down, which is how the tab body once showed an error the header pill knew nothing about.
 */
function noticesFor(
  run: PipelineRunState | null,
  status: PipelineStatus | null,
  failure: PipelineFailure | null,
  outcome: FillOutcome | null,
): RunNotice[] {
  const cause = failure?.message ?? null;

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
      { kind: 'analyze-failed', slot: 'outcome', tone: 'error', action: 'retry-analysis', cause },
    ];
  }

  if (status === 'fill-error') {
    return [{ kind: 'fill-failed', slot: 'inline', tone: 'error', action: 'retry-fill', cause }];
  }

  if (!outcome) return [];

  const notices: RunNotice[] = [];

  // Saving supersedes `fill-complete` alone. "Save the application when you're ready" stops being
  // true once it is saved — but a required field the page rejected is still unfilled on a form the
  // candidate has yet to submit, and the save says nothing about that.
  if (!(status === 'saved' && outcome === 'complete')) notices.push(outcomeNotice(run, outcome));
  if (status === 'saved') notices.push({ kind: 'saved', slot: 'outcome', tone: 'success' });
  if (status === 'save-error') {
    notices.push({
      kind: 'save-failed',
      slot: 'inline',
      tone: 'error',
      action: 'retry-save',
      cause,
    });
  }

  return notices;
}

/**
 * Everything the panel needs to render `run` — the header pill, whether a review still stands, how
 * the Fill Step went, and every Run Notice the run raises.
 *
 * @param status - The *reconciled* status; see {@link readingOf}.
 * @param failure - The reconciled cause that goes with `status`; see {@link noticesFor}. Defaults to
 *   the run's own, which is the whole answer for a caller with no delivery failure to apply.
 */
export function reviewOf(
  run: PipelineRunState | null,
  status: PipelineStatus | null = run?.status ?? null,
  failure: PipelineFailure | null = run?.failure ?? null,
): RunReview {
  const reading = readingOf(run, status);
  return { ...reading, notices: noticesFor(run, status, failure, reading.outcome) };
}
