/**
 * The Application Pipeline: the Analysis, Fill and explicit Save Steps.
 *
 * Runs in the service worker so a step survives the panel closing. Each step returns the patch it
 * checkpoints into `lib/tabStore/pipelineRun.ts` (the one place the run's shape lives); the panel
 * observes it through `chrome.storage.onChanged`.
 */
import {
  autofillApplicationPayload,
  findDuplicate,
  keywordCoverage,
  resumeFileName,
  splitPreparedQuestions,
} from '@djobi/shared';
import type { JobInfo, Profile, QuestionAnswer } from '@djobi/shared';
import { frameForFill, snapshotForRun } from './detectedFields';
import { asksForResume, fillReport, planFill } from './fillPlan';
import { httpBackendClient, type BackendClient } from '../lib/backendClient';
import { autofillSource } from '../lib/fieldDisposition';
import { STEP_STATUS } from '../lib/run';
import type { ClaimResult, JobPageData, ShowSavedToastCommandMessage } from '../lib/messages';
import { chromePageClient, notifyPage, type PageClient } from '../lib/pageClient';
import type { DetectedFrameRef } from '../lib/tabStore/detectedPage';
import {
  type AnalyzedRun,
  type DuplicateApplication,
  type PipelineRunState,
  asAnalyzedRun,
} from '../lib/run';
import { withRunClaim, type RunClaim } from './runClaim';
import { showSavedBadge } from './saveBadge';

/**
 * The tab's Detected Fields as the pipeline reads them — the two I/O calls into
 * `background/detectedFields.ts`. The pure `mergeRescan` is imported directly.
 */
export interface DetectedFieldsPort {
  snapshotForRun(tabId: number): Promise<JobPageData>;
  frameForFill(tabId: number): Promise<DetectedFrameRef | null>;
}

/** The backend routes the Application Pipeline calls, and only those. */
export type PipelineBackend = Pick<
  BackendClient,
  | 'analyzeApplication'
  | 'renderResumePdf'
  | 'getProfile'
  | 'saveApplication'
  | 'updateApplication'
  | 'findApplicationDuplicates'
>;

/** The page calls the pipeline makes. Posting extraction (`readPosting`) is the panel's. */
export type PipelinePage = Pick<PageClient, 'fill' | 'scan'>;

/**
 * Everything the Application Pipeline reaches outside itself for — the seam a test replaces whole:
 * which backend, which page, and which tab's detection.
 */
export interface PipelineDeps {
  backend: PipelineBackend;
  page: PipelinePage;
  detection: DetectedFieldsPort;
  /** How a completed save is announced. Optional: it's pure output that tests may ignore. */
  saveNotice?: SaveNotice;
}

/**
 * Announces a recorded application on the surfaces that outlive the submission
 * (`background/saveBadge.ts`, `content/savedToast.ts`). Separate from {@link PageClient} since the
 * badge isn't the page and neither call awaits a reply.
 */
export interface SaveNotice {
  announce(tabId: number, job: { company: string; roleTitle: string }): void;
}

/** The production detection adapter: the tab's real Detected Fields. */
export const productionDetection: DetectedFieldsPort = { snapshotForRun, frameForFill };

/**
 * The production announcement: a toolbar badge plus a toast in whichever frame still exists. Both
 * are fire-and-forget and never reject into the Save Step.
 */
export const productionSaveNotice: SaveNotice = {
  announce(tabId, job) {
    void showSavedBadge(tabId);
    const message: ShowSavedToastCommandMessage = {
      type: 'SHOW_SAVED_TOAST',
      company: job.company,
      roleTitle: job.roleTitle,
    };
    notifyPage(tabId, message);
  },
};

/** The production adapters; `background/router.ts` uses them as its default. */
export const productionDeps: PipelineDeps = {
  backend: httpBackendClient,
  page: chromePageClient,
  detection: productionDetection,
  saveNotice: productionSaveNotice,
};

type AnalysisResult = Pick<
  PipelineRunState,
  'status' | 'tailoredResume' | 'answers' | 'coverage'
> & { jobInfo: JobInfo };

/**
 * The Analysis Step: one `POST /analyze` round trip for Job Info, Tailored Resume and Question
 * Answers. Question selection, the prepared-answer split, page answer order and Keyword Coverage
 * stay here — they need Detected Fields or the full Profile, which the backend doesn't receive.
 */
async function analysisStep(
  jobDescription: string,
  jobPageData: JobPageData,
  profile: Profile,
  deps: PipelineDeps,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  const questions = jobPageData.fields
    .filter((field) => autofillSource(field.category) === 'question')
    // Only labels cross to the backend; answers come back as one of them, and `fillForm.ts` matches
    // against this same `field.options` to find the element.
    .map((field) => ({
      fieldId: field.id,
      question: field.label,
      options: field.options?.map((option) => option.label),
    }));

  // Anything the profile already answers is settled here, not by the model. A question the profile
  // knows but can't map onto this form's wording still goes to the model, carrying the fact.
  const { resolved, forModel } = splitPreparedQuestions(profile, questions);

  // Only required questions are worth a model call. Profile-answered questions are kept whichever
  // half of the split they fell into: `resolved` never reaches the model, and `knownAnswer` ones
  // are settled locally by `answerQuestions` — dropping them would only leave answered questions
  // blank.
  const requiredFieldIds = new Set(
    jobPageData.fields.filter((field) => field.required).map((field) => field.id),
  );
  const toDraft = forModel.filter(
    (question) => question.knownAnswer !== undefined || requiredFieldIds.has(question.fieldId),
  );

  // `toDraft` may be empty; the backend then answers `[]` without a model call.
  const {
    jobInfo,
    tailoredResume,
    answers: drafted,
  } = await deps.backend.analyzeApplication(jobDescription, profile, toDraft, signal);

  const prepared: QuestionAnswer[] = resolved.map((question) => ({
    fieldId: question.fieldId,
    question: question.question,
    answer: question.answer,
    // No story was drawn on: this came from the profile's prepared answers, not from the model.
    sourceStoryIds: [],
  }));

  // Back into the page's own field order, so the panel's review list reads down the form rather
  // than showing every prepared answer first.
  const answerByFieldId = new Map(
    [...prepared, ...drafted].map((answer) => [answer.fieldId, answer]),
  );
  const answers = questions
    .map((question) => answerByFieldId.get(question.fieldId))
    .filter((answer): answer is QuestionAnswer => answer !== undefined);

  // Measured here and checkpointed with the run, so a restored run shows the report for the resume
  // it actually produced. Pure; no backend call.
  const coverage = keywordCoverage(tailoredResume, jobInfo, profile);

  return { status: STEP_STATUS.analysis.succeeded, jobInfo, tailoredResume, answers, coverage };
}

/**
 * The Fill Step for an analyzed run. Takes the claim because the identity gates below are only
 * correct where this step places them; {@link AnalyzedRun} encodes the Analysis-finished
 * precondition.
 */
async function fillStep(
  claim: RunClaim<AnalyzedRun>,
  profile: Profile,
  tabId: number,
  deps: PipelineDeps,
): Promise<Pick<
  PipelineRunState,
  | 'status'
  | 'unresolvedRequiredFields'
  | 'filledFieldCount'
  | 'fillOutcome'
  | 'jobPageData'
  | 'failure'
> | null> {
  const { run, signal } = claim;
  const { jobPageData, tailoredResume } = run;

  // Rescan the frame that reported the form (so we fill what's there now); if navigation destroyed
  // it, retry only this read-only scan as a broadcast — never the fill itself, since clicks and
  // uploads aren't idempotent. The run's own detection is the fallback when nothing answers.
  //
  // When the analyzed form already asked for a resume, render it alongside the scan (it's the
  // slowest request here). Its own controller, linked to the step's signal, aborts it if the run is
  // superseded or the fresh scan doesn't need it; the `catch` keeps a dropped render from becoming
  // an unhandled rejection, while a used one still throws through `early`.
  const earlyAbort = new AbortController();
  const abortEarly = () => earlyAbort.abort();
  signal.addEventListener('abort', abortEarly, { once: true });
  if (signal.aborted) abortEarly();
  const early = asksForResume(jobPageData.fields)
    ? deps.backend.renderResumePdf(profile, tailoredResume, earlyAbort.signal)
    : undefined;
  early?.catch(() => {});

  let frameId: number | undefined;
  let scanned: Awaited<ReturnType<typeof deps.page.scan>>;
  try {
    frameId = (await deps.detection.frameForFill(tabId))?.frameId;
    scanned = await deps.page.scan(tabId, frameId);
    if (frameId !== undefined && scanned === null) {
      frameId = undefined;
      scanned = await deps.page.scan(tabId);
    }
  } catch (error) {
    abortEarly();
    throw error;
  }
  const plan = planFill(run, scanned?.fields ?? null, profile);
  const { fields, values, needsResume } = plan;

  // Rendering and filling can outlive a navigation or replacement analysis. Re-check after the
  // awaited scan before either operation can produce an upload or click against the wrong page.
  if (!needsResume) abortEarly();
  if (!(await claim.stillOurs())) {
    abortEarly();
    return null;
  }
  const resume = needsResume
    ? {
        name: resumeFileName(profile.fullName),
        type: 'application/pdf',
        // The one place this step spends model time, and therefore the one worth cancelling: a
        // superseding run aborts it rather than leaving a PDF rendering for a run nothing will use.
        bytes: await (early ?? deps.backend.renderResumePdf(profile, tailoredResume, signal)),
      }
    : undefined;

  // The render has settled (or was never needed); stop listening on the step's signal.
  signal.removeEventListener('abort', abortEarly);

  // PDF rendering is another await, so the run may have been superseded while it was in flight.
  // Keep this adjacent to the irreversible page command; there is no await between the check and
  // it.
  if (!(await claim.stillOurs())) return null;

  // No frame can own an empty command, so sending it would necessarily return `null` and erase the
  // useful distinction between "no form fields" and "a real fill whose response was lost".
  const filled =
    fields.length === 0
      ? { ok: true as const, filledFieldIds: [], resumeAttached: false }
      : await deps.page.fill(tabId, { runId: run.runId, fields, values, resume }, frameId);

  const { unresolvedRequiredFields, filledFieldCount, fillOutcome } = fillReport(
    plan,
    filled,
    resume !== undefined,
  );

  // The re-scan is checkpointed back onto the run so the panel reports what was actually filled —
  // `unresolvedRequiredFields` above is derived from these fields, and the panel lists them.
  return {
    status: STEP_STATUS.fill.succeeded,
    unresolvedRequiredFields,
    filledFieldCount,
    fillOutcome,
    jobPageData: { ...jobPageData, fields },
    failure: null,
  };
}

/**
 * Saves the current filled snapshot: creates it once, then replaces it on later saves.
 *
 * `cancellation: 'none'`: aborting an in-flight write can't tell whether the row landed, so a
 * superseding run lets it finish (its checkpoint is dropped by run identity). The create sends
 * `run.runId` as the idempotency key, so a retried first save returns the same row; later saves go
 * through `updateApplication`, which is idempotent.
 */
export async function runSaveApplication(
  tabId: number,
  deps: PipelineDeps = productionDeps,
  expectedRunId?: string,
  onClaimed?: (outcome: ClaimResult) => void,
): Promise<void> {
  await withRunClaim(
    tabId,
    {
      step: 'save',
      mode: 'transition',
      cancellation: 'none',
      expectedRunId,
      requires: asAnalyzedRun,
      onClaimed,
    },
    async ({ run }) => {
      // Read fresh at save time; if it can't be read, provenance fields are stored as `null` rather
      // than failing the save.
      const profile = await deps.backend.getProfile().catch(() => null);
      const payload = autofillApplicationPayload(run, profile);

      const application = run.applicationId
        ? await deps.backend.updateApplication(run.applicationId, payload)
        : await deps.backend.saveApplication(payload, run.runId);

      // After the write, and only on the path where it succeeded: the badge and the toast are a
      // report of a row that exists. `run.jobInfo` is present because `asAnalyzedRun` narrowed it.
      deps.saveNotice?.announce(tabId, {
        company: run.jobInfo.company,
        roleTitle: run.jobInfo.roleTitle,
      });

      return { status: STEP_STATUS.save.succeeded, applicationId: application.id, failure: null };
    },
  );
}

/**
 * Starts a run: analyzes the candidate-reviewed `jobDescription` (the only posting input — the page
 * is consulted only for its form) and drafts everything the Fill Step will write.
 *
 * Unless `force` is set, a posting already saved ends the run at `duplicate` before any LLM call.
 * The guard lives here because Analyze, Re-analyze and Try again all funnel through this function.
 */
export async function runAnalysis(
  tabId: number,
  tabUrl: string | null,
  profile: Profile,
  jobDescription: string,
  deps: PipelineDeps = productionDeps,
  force = false,
): Promise<void> {
  if (!jobDescription.trim()) return; // nothing to analyze — mirrors the panel's own guard

  await withRunClaim(
    tabId,
    {
      step: 'analysis',
      mode: 'replace',
      cancellation: 'supersede',
      // The only step that mints a run identity; every later completion is scoped to it, so a new
      // Analyze or a navigation supersedes it safely.
      seed: (runId) => ({
        runId,
        status: STEP_STATUS.analysis.running,
        tabUrl,
        jobPageData: { fields: [] },
        jobDescription,
        analyzedJobDescription: jobDescription,
        jobInfo: null,
        tailoredResume: null,
        answers: [],
        coverage: [],
        unresolvedRequiredFields: [],
        filledFieldCount: 0,
        fillOutcome: null,
        applicationId: null,
        failure: null,
        duplicateOf: null,
      }),
    },
    async (claim) => {
      // Waits (bounded) for in-flight API-oracle enrichment, so questions carry the API's wording
      // of choices — otherwise drafted answers may match no element at fill time.
      const [jobPageData, duplicateOf]: [JobPageData, DuplicateApplication | null] =
        await Promise.all([
          deps.detection.snapshotForRun(tabId),
          force ? Promise.resolve(null) : findDuplicate(deps.backend, tabUrl, claim.signal),
        ]);

      const stillCurrent = await claim.checkpoint({
        status: duplicateOf ? 'duplicate' : STEP_STATUS.analysis.running,
        jobPageData,
        duplicateOf,
      });

      if (!stillCurrent) return null;

      // Stop before any paid model work on a posting the candidate has already applied to.
      if (duplicateOf) return null;

      return analysisStep(jobDescription, jobPageData, profile, deps, claim.signal);
    },
  );
}

export async function runFill(
  tabId: number,
  profile: Profile,
  deps: PipelineDeps = productionDeps,
  expectedRunId?: string,
  onClaimed?: (outcome: ClaimResult) => void,
): Promise<void> {
  await withRunClaim(
    tabId,
    {
      step: 'fill',
      mode: 'transition',
      cancellation: 'supersede',
      expectedRunId,
      requires: asAnalyzedRun,
      onClaimed,
    },
    (claim) => fillStep(claim, profile, tabId, deps),
  );
}
