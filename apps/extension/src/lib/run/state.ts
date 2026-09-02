/**
 * What an Application Pipeline run *is* — the record the pipeline checkpoints and the panel renders.
 *
 * Types and pure narrowing only. How a run is stored is `lib/tabStore/pipelineRun.ts`, one layer
 * up; how it is read for a candidate is `lib/run/review.ts`, beside this. Keeping the shape apart
 * from its persistence is what lets the panel and the background agree on a run without either
 * importing the other's storage.
 */
import type {
  ApplicationStage,
  DetectedField,
  JobInfo,
  KeywordCoverage,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
// A type-only import of a plain data shape — the fields a scan produced. `lib/messages.ts` declares
// it because the content script's report carries it; nothing about the transport comes with it, and
// there is no import back the other way.
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

/**
 * What the candidate already has on file for this job posting, when the duplicate guard stopped a
 * run.
 *
 * A flattened summary rather than the whole `Application`: the panel needs five fields to explain
 * itself, and storing the full record would put a tailored resume and every answer into
 * `chrome.storage.session` for a run that deliberately did no work.
 */
export interface DuplicateApplication {
  id: string;
  company: string;
  roleTitle: string;
  /**
   * Where that past application got to. Shown because it changes what the notice means: an
   * `onsite` row is a live process, a `rejected` one from a year ago may be worth retrying.
   */
  stage: ApplicationStage;
  /** The *most recent* save for this posting — the lookup returns matches newest-first. */
  createdAt: string;
  /** How many saved applications share this posting. Greater than one means repeated applications. */
  count: number;
}

export interface PipelineRunState {
  /** Identifies this attempt so async work cannot update a newer run for the same tab. */
  runId: string;
  status: import('./status').PipelineStatus;
  tabUrl: string | null;
  jobPageData: JobPageData;
  /**
   * The job description shown in the panel's editor. Starts equal to {@link analyzedJobDescription}
   * but can drift from it: the candidate may edit this text after Analysis has already produced
   * `jobInfo`/`tailoredResume`, and editing alone does not re-run Analysis. Kept on the run so the
   * panel can show it back for editing and a re-analysis, and so a reopened panel doesn't lose it.
   */
  jobDescription: string;
  /**
   * The exact text passed to `extractJob` for this run's `jobInfo`/`tailoredResume` — frozen at the
   * start of the Analysis Step, unlike {@link jobDescription}, which the candidate can keep editing
   * afterward. This is what Save persists as `rawDescription`, so that field always names the
   * posting text the pipeline's output actually reflects, even if the editor has since diverged.
   */
  analyzedJobDescription: string;
  jobInfo: JobInfo | null;
  tailoredResume: TailoredResume | null;
  answers: QuestionAnswer[];
  /**
   * What `tailoredResume` evidences of `jobInfo.keywords`, computed in the Analysis Step. Empty
   * before it completes, and empty for a posting whose extraction found no keywords — the panel
   * shows nothing in both cases, which is the honest reading of each.
   */
  coverage: KeywordCoverage[];
  /** Set alongside an `analyze-error`/`fill-error` status; cleared on every fresh attempt. */
  failure: PipelineFailure | null;
  /** Required fields the Fill Step couldn't resolve a value for. Populated once it completes. */
  unresolvedRequiredFields: DetectedField[];
  /** Set by the Fill Step from the page's response; `null` before it completes. */
  fillOutcome: FillOutcome | null;
  /**
   * How many fields the Fill Step wrote when a frame confirmed the result, resume included. For an
   * `unverified` outcome this is the optimistic attempted count. Zero can mean no fields were
   * detected, which `unresolvedRequiredFields` alone cannot distinguish from success.
   */
  filledFieldCount: number;
  /** The permanent record created by the first explicit save, if any. */
  applicationId: string | null;
  /** Set alongside a `duplicate` status; `null` on every run that was allowed to proceed. */
  duplicateOf: DuplicateApplication | null;
}

/**
 * A run whose Analysis Step has completed. Encoding the Fill Step's precondition as a type means a
 * caller can't forget to check it — the narrowing happens once, where the run is read.
 */
export type AnalyzedRun = PipelineRunState & {
  jobInfo: JobInfo;
  tailoredResume: TailoredResume;
};

/** Narrows a run to one the Fill Step can act on, or `null` if the Analysis Step hasn't finished. */
export function asAnalyzedRun(run: PipelineRunState | null): AnalyzedRun | null {
  return run?.jobInfo && run.tailoredResume ? (run as AnalyzedRun) : null;
}

/**
 * The run fields a candidate edits directly — everything else is the background's to checkpoint.
 *
 * The single fact `lib/tabStore/record.ts` and `panel/usePipelineRun.ts` each need in order to tell
 * a candidate's own edit apart from the background's progress. Stated once, here, because the two
 * sides restating it independently is exactly how `tailoredResume` ended up panel-writable per one
 * list and background-owned per the other — a mid-fill resume edit read as background progress and
 * stood the optimistic "Filling…" status down early, silently, since nothing forced the two lists to
 * agree.
 */
export const PANEL_EDITABLE_FIELDS = ['answers', 'jobDescription', 'tailoredResume'] as const;
type PanelEditableField = (typeof PANEL_EDITABLE_FIELDS)[number];

/** The panel's own edits — the subset of a run `panel/usePipelineRun.ts` may write directly. */
export function panelEditsOf(run: PipelineRunState): Pick<PipelineRunState, PanelEditableField> {
  const entries = PANEL_EDITABLE_FIELDS.map((field) => [field, run[field]]);
  // Safe: entries is exactly PANEL_EDITABLE_FIELDS paired with that field's own value off `run`.
  return Object.fromEntries(entries) as Pick<PipelineRunState, PanelEditableField>;
}

/** The run fields the background checkpoints, for `lib/tabStore/record.ts`'s movement classifier. */
export function backgroundProgressOf(
  run: PipelineRunState,
): Omit<PipelineRunState, PanelEditableField> {
  const panelFields: readonly string[] = PANEL_EDITABLE_FIELDS;
  const entries = Object.entries(run).filter(([field]) => !panelFields.includes(field));
  // Safe: entries is exactly `Object.entries(run)` minus the panel fields filtered above.
  return Object.fromEntries(entries) as Omit<PipelineRunState, PanelEditableField>;
}
