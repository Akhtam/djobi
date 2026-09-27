/**
 * What a pipeline run *is* — the record the pipeline checkpoints and the panel renders. Types and
 * pure narrowing only; storage is `lib/tabStore/pipelineRun.ts`, presentation `lib/run/review.ts`.
 */
import type {
  DetectedField,
  DuplicateApplication,
  JobInfo,
  KeywordCoverage,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
// Type-only: a plain data shape declared beside the content script's report.
import type { JobPageData } from '../messages';
import type { RunStep } from './status';

/** The Fill Step's authoritative reading of what the page confirmed. */
export type FillOutcome =
  'unverified' | 'no-fields-detected' | 'nothing-filled' | 'complete' | 'incomplete';

export const RUN_FAILURE_KINDS = [
  'temporary',
  'backend-unreachable',
  'invalid-page',
  'invalid-model-output',
  'unauthorized',
  'cancelled',
  'unknown',
] as const;
export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];

export function isRunFailureKind(value: unknown): value is RunFailureKind {
  return RUN_FAILURE_KINDS.includes(value as RunFailureKind);
}

/** A stable domain classification of why one pipeline step failed. */
export interface PipelineFailure {
  /** Which pipeline operation failed. */
  step: RunStep;
  /** Smaller than transport/provider vocabularies so panel wording stays stable. */
  kind: RunFailureKind;
}

// Re-exported for importers of `../lib/run`.
export type { DuplicateApplication };

export interface PipelineRunState {
  /** Identifies this attempt so async work cannot update a newer run for the same tab. */
  runId: string;
  status: import('./status').PipelineStatus;
  tabUrl: string | null;
  jobPageData: JobPageData;
  /**
   * The description in the panel's editor. Starts as {@link analyzedJobDescription} and may be
   * edited afterwards without re-running analysis.
   */
  jobDescription: string;
  /**
   * The exact text analyzed, frozen at the Analysis Step. Saved as `rawDescription`, so it always
   * matches what produced `jobInfo`/`tailoredResume`.
   */
  analyzedJobDescription: string;
  jobInfo: JobInfo | null;
  tailoredResume: TailoredResume | null;
  answers: QuestionAnswer[];
  /**
   * What `tailoredResume` evidences of `jobInfo.keywords`, from the Analysis Step. Empty before
   * then or when there are no keywords.
   */
  coverage: KeywordCoverage[];
  /** Set alongside an `analyze-error`/`fill-error` status; cleared on every fresh attempt. */
  failure: PipelineFailure | null;
  /** Required fields the Fill Step couldn't resolve a value for. Populated once it completes. */
  unresolvedRequiredFields: DetectedField[];
  /** Set by the Fill Step from the page's response; `null` before it completes. */
  fillOutcome: FillOutcome | null;
  /**
   * Fields the Fill Step wrote, resume included (attempted count if `unverified`). Zero may mean
   * nothing was detected, which `unresolvedRequiredFields` alone can't show.
   */
  filledFieldCount: number;
  /** The permanent record created by the first explicit save, if any. */
  applicationId: string | null;
  /** Set alongside a `duplicate` status; `null` on every run that was allowed to proceed. */
  duplicateOf: DuplicateApplication | null;
}

/** A run whose Analysis Step completed — the Fill Step's precondition as a type. */
export type AnalyzedRun = PipelineRunState & {
  jobInfo: JobInfo;
  tailoredResume: TailoredResume;
};

/**
 * Narrows a run to one the Fill Step can act on, or `null` if the Analysis Step hasn't finished.
 */
export function asAnalyzedRun(run: PipelineRunState | null): AnalyzedRun | null {
  return run?.jobInfo && run.tailoredResume ? (run as AnalyzedRun) : null;
}

/**
 * The run fields a candidate edits directly; everything else is the background's. Shared by
 * `tabStore/record.ts` and `usePipelineRun.ts` to tell a candidate edit from background progress.
 */
export const PANEL_EDITABLE_FIELDS = ['answers', 'jobDescription', 'tailoredResume'] as const;
type PanelEditableField = (typeof PANEL_EDITABLE_FIELDS)[number];

/** The panel's own edits — the subset of a run `panel/usePipelineRun.ts` may write directly. */
export function panelEditsOf(run: PipelineRunState): Pick<PipelineRunState, PanelEditableField> {
  const entries = PANEL_EDITABLE_FIELDS.map((field) => [field, run[field]]);
  // Safe: entries is exactly PANEL_EDITABLE_FIELDS paired with that field's own value off `run`.
  return Object.fromEntries(entries) as Pick<PipelineRunState, PanelEditableField>;
}

/**
 * The run fields the background checkpoints, for `lib/tabStore/record.ts`'s movement classifier.
 */
export function backgroundProgressOf(
  run: PipelineRunState,
): Omit<PipelineRunState, PanelEditableField> {
  const panelFields: readonly string[] = PANEL_EDITABLE_FIELDS;
  const entries = Object.entries(run).filter(([field]) => !panelFields.includes(field));
  // Safe: entries is exactly `Object.entries(run)` minus the panel fields filtered above.
  return Object.fromEntries(entries) as Omit<PipelineRunState, PanelEditableField>;
}
