import type { PipelineRunState } from './tabStore';

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
 */
export type FillOutcome = 'nothing-filled' | 'complete' | 'incomplete';

/** The header pill: what it says, and how it should look. */
export interface StatusPill {
  label: string;
  tone: 'busy' | 'success' | 'error';
}

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
}

/** The review with nothing to show — no run yet, or one that has produced nothing worth reporting. */
const IDLE: RunReview = { pill: null, canReview: false, outcome: null };

/** How the Fill Step went, from the two counts the run records. */
function outcomeOf(run: PipelineRunState): FillOutcome {
  if (run.filledFieldCount === 0) return 'nothing-filled';
  return run.unresolvedRequiredFields.length > 0 ? 'incomplete' : 'complete';
}

const OUTCOME_PILL: Record<FillOutcome, StatusPill> = {
  'nothing-filled': { label: 'Nothing filled', tone: 'error' },
  incomplete: { label: 'Incomplete', tone: 'error' },
  complete: { label: 'Done', tone: 'success' },
};

/** Everything the panel needs to render `run`, derived once. */
export function reviewOf(run: PipelineRunState | null): RunReview {
  if (!run) return IDLE;

  switch (run.status) {
    case 'analyzing':
      return { pill: { label: 'Analyzing…', tone: 'busy' }, canReview: false, outcome: null };

    case 'analyze-error':
      return { pill: { label: 'Error', tone: 'error' }, canReview: false, outcome: null };

    case 'review':
      return { pill: { label: 'Ready to fill', tone: 'success' }, canReview: true, outcome: null };

    case 'filling':
      return { pill: { label: 'Filling…', tone: 'busy' }, canReview: true, outcome: null };

    case 'fill-error':
      return { pill: { label: 'Error', tone: 'error' }, canReview: true, outcome: null };

    case 'filled': {
      const outcome = outcomeOf(run);
      return { pill: OUTCOME_PILL[outcome], canReview: true, outcome };
    }
  }
}
