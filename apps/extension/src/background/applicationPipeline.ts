/**
 * The Application Pipeline: Analysis, Fill and explicit Save Steps, checkpointed into
 * `lib/tabStore/pipelineRun.ts`.
 *
 * It runs in the background service worker rather than the panel, so an in-flight step survives the
 * panel that requested it closing mid-run — a panel-driven version drops the result on the floor in
 * that case, because closing the panel tears down the `chrome.runtime.sendMessage` port a direct
 * call would be waiting on. Progress is checkpointed into `lib/tabStore/pipelineRun.ts` as it
 * happens; the panel observes it via `chrome.storage.onChanged` (`panel/usePipelineRun.ts`) rather
 * than a message response.
 *
 * Each step returns the patch it checkpoints, and the run's shape lives only in
 * `lib/tabStore/pipelineRun.ts`. Splitting the steps from their checkpointing models a run twice —
 * every new step output then has to be added to the step, to whatever spreads its result, and to
 * the store.
 */
import { keywordCoverage, resumeFileName, splitPreparedQuestions } from '@djobi/shared';
import type { DetectedField, JobInfo, Profile, QuestionAnswer } from '@djobi/shared';
import { frameForFill, mergeRescan, snapshotForRun } from './detectedFields';
import { httpBackendClient, type BackendClient } from '../lib/backendClient';
import { autofillSource, valueForCategory } from '../lib/fieldDisposition';
import { answersFor, STEP_STATUS } from '../lib/run';
import type { JobPageData } from '../lib/messages';
import { chromePageClient, type PageClient } from '../lib/pageClient';
import {
  type AnalyzedRun,
  type DuplicateApplication,
  type FillOutcome,
  type PipelineRunState,
  asAnalyzedRun,
} from '../lib/run';
import { findDuplicate } from '../lib/duplicateGuard';
import { withRunClaim, type RunClaim } from './runClaim';

/**
 * Everything the Application Pipeline reaches outside itself for — the seam a test replaces whole.
 *
 * Two collaborators, not the seven loose methods this used to be. Four of those were one-line
 * wrappers over `callBackend`, so the interface grew a method for every backend route the pipeline
 * touched while hiding nothing, and every test had to supply all seven to exercise any one of them.
 * The two things that genuinely vary here are *which backend* and *which page*, so those are the
 * two names.
 */
export interface PipelineDeps {
  backend: BackendClient;
  page: PageClient;
}

/**
 * The production adapter: the local backend, and the tab's own content script.
 *
 * Exported so `background/router.ts` can name it as its own default — the seam is widened to the
 * dispatch above these functions, not just to each of them, so a caller substituting the adapter
 * substitutes it once for the whole protocol.
 */
export const productionDeps: PipelineDeps = {
  backend: httpBackendClient,
  page: chromePageClient,
};

type AnalysisResult = Pick<
  PipelineRunState,
  'status' | 'tailoredResume' | 'answers' | 'coverage'
> & { jobInfo: JobInfo };

/** The Analysis Step: Job Info, then a Tailored Resume and Question Answers drafted from it. */
async function analysisStep(
  jobDescription: string,
  jobPageData: JobPageData,
  profile: Profile,
  deps: PipelineDeps,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  const jobInfo = await deps.backend.extractJob(jobDescription, signal);

  const questions = jobPageData.fields
    .filter((field) => autofillSource(field.category) === 'question')
    // Only the labels cross to the backend — a choice's DOM selector is meaningless there, and
    // the drafted answer comes back as one of these label strings, which `fillForm.ts` matches
    // against this same `field.options` array to recover the element.
    .map((field) => ({
      fieldId: field.id,
      question: field.label,
      options: field.options?.map((option) => option.label),
    }));

  // Anything the profile already answers is settled here, not by the model. A question the profile
  // knows but can't map onto this form's wording still goes to the model, carrying the fact.
  const { resolved, forModel } = splitPreparedQuestions(profile, questions);

  // Only a required question is worth a *model call*. An optional one is a box the candidate can
  // leave empty, and drafting it costs the same wall clock as a required one — on the Analysis
  // Step's slowest call, where every answer is written before any of them arrives.
  //
  // A question the profile already answers is not filtered out, whichever half of the split it fell
  // into. `resolved` never reaches the model at all; a `knownAnswer` one nominally does, but
  // `answerQuestions` settles it locally by matching the stated fact onto this form's options and
  // asks the model nothing about it — so dropping it here would not save a token, it would only
  // leave a question the candidate has answered blank on the page.
  const requiredFieldIds = new Set(
    jobPageData.fields.filter((field) => field.required).map((field) => field.id),
  );
  const toDraft = forModel.filter(
    (question) => question.knownAnswer !== undefined || requiredFieldIds.has(question.fieldId),
  );

  const [tailoredResume, drafted] = await Promise.all([
    deps.backend.tailorResume(profile, jobInfo, signal),
    // Not even a round trip when the profile answered everything the form asks: the backend would
    // return `[]` without a model call, and the Analysis Step is the wrong place to spend a request
    // establishing that.
    toDraft.length > 0
      ? deps.backend.answerQuestions(profile, jobInfo, toDraft, signal)
      : Promise.resolve([]),
  ]);

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

  // Measured here rather than in the panel so the report is of the resume this run actually
  // produced, and is checkpointed with it — a panel that recomputed on render would re-measure a
  // restored run against whatever the module happened to say by then. Pure and synchronous: it
  // costs no backend call and adds nothing to the worker's fetch exposure.
  const coverage = keywordCoverage(tailoredResume, jobInfo);

  return { status: STEP_STATUS.analysis.succeeded, jobInfo, tailoredResume, answers, coverage };
}

/**
 * The Fill Step for an already-analyzed run.
 *
 * Takes the claim rather than the run plus a loose signal: the run is the unit that crosses this
 * seam anyway, and the two identity gates below are only correct in the positions this step puts
 * them in, so it is this step — not the claim — that decides where they go. {@link AnalyzedRun}
 * carries the precondition (Analysis Step finished) in the type, so it can't be skipped here.
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
  const { jobPageData, jobInfo, tailoredResume, tabUrl } = run;

  // Fill what the page holds *now*, not what it held when the Analysis Step started. The run's own
  // detection is the fallback for a page that can't be re-scanned (no content script — the tab was
  // open across an extension reload), and it's the only source at all for a run analyzed from a
  // pasted job description before the form had rendered, where it is empty.
  // Address the frame that reported the form. If navigation destroyed that frame, retry only this
  // read-only scan as a broadcast and use broadcast addressing for the single fill attempt below.
  // Retrying fill itself would be unsafe: clicks and uploads are not idempotent.
  let frameId = (await frameForFill(tabId))?.frameId;
  let scanned = await deps.page.scan(tabId, frameId);
  if (frameId !== undefined && scanned === null) {
    frameId = undefined;
    scanned = await deps.page.scan(tabId);
  }
  // The fresh scan has the right elements; the analyzed run has the right wording. `mergeRescan`
  // keeps both — without it the re-scan silently discarded every API-supplied option label and
  // `required` flag, because enrichment only ever attached on the report path, never on `SCAN_PAGE`.
  const fields = scanned?.fields.length
    ? mergeRescan(scanned.fields, jobPageData.fields)
    : jobPageData.fields;
  // Resolved through the run, so the panel's warning and this fill agree by construction — see
  // `lib/runAnswers.ts`. `run` is the analyzed snapshot, which is the only correct source for the
  // labels: `fields` above is the *fresh* scan.
  const drafted = answersFor(run);

  // Analysis may have happened on an ATS overview route before its application questions mounted,
  // so the fresh scan can hold questions this run never drafted an answer for. Those are left
  // blank for the candidate to write themselves rather than blocking the whole fill: everything
  // that *does* have a reviewed answer still lands, and an unanswered required question comes back
  // in `unresolvedRequiredFields` below, which is what the panel lists.
  const values: Record<string, string> = {};
  for (const field of fields) {
    // Every category has a disposition, and `lib/fieldDisposition.ts` is where it is stated. A
    // category this app deliberately leaves alone — a cover letter — takes the same path as one
    // nothing recognizes, which is what it did before; the difference is that saying so is now a
    // table entry rather than a `default` branch indistinguishable from an oversight.
    switch (autofillSource(field.category)) {
      case 'question': {
        const answer = drafted.valueFor(field);
        if (answer !== undefined) values[field.id] = answer;
        break;
      }
      case 'profile': {
        const value = valueForCategory(field.category, profile);
        if (value !== undefined) values[field.id] = value;
        break;
      }
      // The resume is attached as a file rather than written as a value, below; `unsupported` is
      // the recorded decision not to fill this category at all.
      case 'resume':
      case 'unsupported':
        break;
    }
  }

  // Whether to render a resume at all — not which input it lands on. An ATS can render several
  // `resume_upload`-classified inputs (Ashby pairs an unlabeled decoy with the real, required one),
  // and picking between them needs the live page, so `content/fillForm.ts` does it. This module used
  // to pick one too, purely to decide this boolean, and the two copies of that rule could disagree.
  const needsResume = fields.some((field) => autofillSource(field.category) === 'resume');
  // Rendering and filling can outlive a navigation or replacement analysis. Re-check after the
  // awaited scan before either operation can produce an upload or click against the wrong page.
  if (!(await claim.stillOurs())) return null;
  const resume = needsResume
    ? {
        name: resumeFileName(profile.fullName),
        type: 'application/pdf',
        // The one place this step spends model time, and therefore the one worth cancelling: a
        // superseding run aborts it rather than leaving a PDF rendering for a run nothing will use.
        bytes: await deps.backend.renderResumePdf(profile, tailoredResume, signal),
      }
    : undefined;

  // PDF rendering is another await, so the run may have been superseded while it was in flight.
  // Keep this adjacent to the irreversible page command; there is no await between the check and it.
  if (!(await claim.stillOurs())) return null;

  // No frame can own an empty command, so sending it would necessarily return `null` and erase the
  // useful distinction between "no form fields" and "a real fill whose response was lost".
  const filled =
    fields.length === 0
      ? { ok: true as const, filledFieldIds: [], resumeAttached: false }
      : await deps.page.fill(tabId, { fields, values, resume }, frameId);

  // What the page confirmed it kept. A run whose content script didn't answer at all (`null`) has
  // no such account, and falling back to the drafted values is the honest reading there: the fill
  // may well have worked, and reporting every field as unresolved would be its own lie.
  const resumeFieldIds = new Set(
    fields.filter((field) => autofillSource(field.category) === 'resume').map((field) => field.id),
  );
  const landed = filled
    ? new Set(filled.filledFieldIds.filter((fieldId) => !resumeFieldIds.has(fieldId)))
    : new Set(Object.keys(values));
  const resumeLanded = filled ? filled.resumeAttached : resume !== undefined;

  // A required field is unresolved if this run never drafted a value for it *or* the page didn't
  // keep the one it was given. The second half is the case that used to go unreported: an ATS
  // whose form model discards a programmatic write (see `content/fillForm.ts`) rejects the
  // submission for a field the panel had just shown as filled, leaving the user to work out which
  // one from the ATS's own error banner.
  const unresolvedRequiredFields = fields.filter(
    (field) =>
      field.required &&
      (autofillSource(field.category) === 'resume' ? !resumeLanded : !landed.has(field.id)),
  );

  // How much this run actually wrote. `unresolvedRequiredFields` can't answer that on its own:
  // it's derived by filtering `fields`, so a run that detected nothing at all produces an empty
  // list — indistinguishable from a run that filled everything perfectly, and the panel rendered
  // both as an unqualified success. The resume counts as a filled field because it's attached by
  // `attachResumeFile` rather than through `values`.
  const filledFieldCount = landed.size + (resumeLanded ? 1 : 0);

  // The page response is the only evidence that can distinguish success from an unanswered
  // message. Keep that fact whole on the run instead of asking the panel to infer certainty from
  // counts that deliberately remain optimistic when no frame answers.
  let fillOutcome: FillOutcome;
  if (fields.length === 0) fillOutcome = 'no-fields-detected';
  else if (filled === null) fillOutcome = 'unverified';
  else if (filledFieldCount === 0) fillOutcome = 'nothing-filled';
  else if (unresolvedRequiredFields.length > 0) fillOutcome = 'incomplete';
  else fillOutcome = 'complete';

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
 * Saves the current filled snapshot, creating it once and replacing it after later edits or fills.
 *
 * **`cancellation: 'none'`, and that is a decision rather than an omission.** This is the one step
 * whose work is a write the server may already have committed. Aborting the request in flight
 * cannot establish whether the row landed, and a run whose `applicationId` is still null writes a
 * *second* Application on the next save — the exact duplicate an update-in-place exists to prevent.
 * Until the write carries an idempotency key, a superseding run leaves this one to finish; its
 * checkpoint is dropped by run identity if the tab has moved on, which costs nothing.
 */
export async function runSaveApplication(
  tabId: number,
  deps: PipelineDeps = productionDeps,
  expectedRunId?: string,
): Promise<void> {
  await withRunClaim(
    tabId,
    {
      step: 'save',
      mode: 'transition',
      cancellation: 'none',
      expectedRunId,
      requires: asAnalyzedRun,
    },
    async ({ run }) => {
      const payload = {
        company: run.jobInfo.company,
        roleTitle: run.jobInfo.roleTitle,
        jobUrl: run.tabUrl ?? '',
        jobInfo: run.jobInfo,
        tailoredResume: run.tailoredResume,
        answers: run.answers,
      };

      const application = run.applicationId
        ? await deps.backend.updateApplication(run.applicationId, payload)
        : await deps.backend.saveApplication(payload);

      return { status: STEP_STATUS.save.succeeded, applicationId: application.id, failure: null };
    },
  );
}

/**
 * Starts a run: analyzes `jobDescription` and drafts everything the Fill Step will write.
 *
 * `jobDescription` is the candidate-reviewed posting text, and it is the only thing analyzed. The page
 * is consulted solely for the *form* — which fields exist to be filled — and a tab with no
 * detection yet still analyzes fine, because the Fill Step re-scans the live page anyway.
 *
 * Unless `force` is set, a job URL the candidate already saved an application for ends the run at
 * `duplicate` before a single LLM call — the guard lives here, rather than in the panel, because
 * every entry point (Analyze, Re-analyze, Try again) already funnels through this function.
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
      // The only step that mints a run: Analyze is the sole entry point that starts one, and it
      // takes the tab from whatever was there. Every completion below is scoped to this identity,
      // so a later Analyze click or a navigation can supersede it safely.
      seed: (runId) => ({
        runId,
        status: STEP_STATUS.analysis.running,
        tabUrl,
        jobPageData: { fields: [] },
        jobDescription,
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
      // Waits for an API-oracle enrichment still in flight for this tab. Clicking Analyze the
      // instant a page loads used to snapshot DOM-only fields, so the questions crossing to the
      // backend carried the page's wording of a combobox's choices instead of the API's — and the
      // answers drafted from them then matched no element at fill time. See
      // `background/detectedFields.ts`.
      const [jobPageData, duplicateOf]: [JobPageData, DuplicateApplication | null] =
        await Promise.all([
          snapshotForRun(tabId),
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
): Promise<void> {
  await withRunClaim(
    tabId,
    {
      step: 'fill',
      mode: 'transition',
      cancellation: 'supersede',
      expectedRunId,
      requires: asAnalyzedRun,
    },
    (claim) => fillStep(claim, profile, tabId, deps),
  );
}
