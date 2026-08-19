/**
 * The Application Pipeline: Analysis, Fill and explicit Save Steps, checkpointed into
 * `lib/tabStore.ts`.
 *
 * It runs in the background service worker rather than the panel, so an in-flight step survives the
 * panel that requested it closing mid-run — a panel-driven version drops the result on the floor in
 * that case, because closing the panel tears down the `chrome.runtime.sendMessage` port a direct
 * call would be waiting on. Progress is checkpointed into `lib/tabStore.ts` as it happens; the panel
 * observes it via `chrome.storage.onChanged` (`panel/usePipelineRun.ts`) rather than a message
 * response.
 *
 * The steps used to live in `panel/pipeline.ts` — a directory nothing in the panel imported from
 * once the run moved here — with this module spreading their loose return values field-by-field
 * into a {@link PipelineRunState}. That modelled a run twice, so adding one step output meant
 * editing both modules and the store. Here each step returns the patch it checkpoints, and the run's
 * shape lives only in `lib/tabStore.ts`.
 */
import { matchAnswerToField, resumeFileName, splitPreparedQuestions } from '@djobi/shared';
import type { DetectedField, Profile, QuestionAnswer } from '@djobi/shared';
import { carryEnrichment } from './apiDetectors';
import { httpBackendClient, type BackendClient } from '../lib/backendClient';
import type { JobPageData } from '../lib/messages';
import { chromePageClient, type PageClient } from '../lib/pageClient';
import {
  asAnalyzedRun,
  getDetectedFrame,
  getDetectedPage,
  getPipelineRun,
  patchPipelineRun,
  setPipelineRun,
  transitionPipelineRun,
  type AnalyzedRun,
  type DuplicateApplication,
  type FillOutcome,
  type PipelineRunState,
  type PipelineStatus,
} from '../lib/tabStore';

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

/** The production adapter: the local backend, and the tab's own content script. */
const productionDeps: PipelineDeps = {
  backend: httpBackendClient,
  page: chromePageClient,
};

/** Maps a scalar (non-question, non-upload) field category to the base profile value that fills it. */
function valueForCategory(
  category: DetectedField['category'],
  profile: Profile,
): string | undefined {
  switch (category) {
    case 'first_name':
      return profile.fullName.split(' ')[0];
    case 'last_name':
      return profile.fullName.split(' ').slice(1).join(' ') || undefined;
    case 'full_name':
      return profile.fullName;
    case 'email':
      return profile.email;
    case 'phone':
      return profile.phone ?? undefined;
    case 'location':
      return profile.location ?? undefined;
    case 'linkedin_url':
      return profile.links.linkedin ?? undefined;
    case 'portfolio_url':
      return profile.links.portfolio ?? undefined;
    case 'github_url':
      return profile.links.github ?? undefined;
    default:
      return undefined;
  }
}

/** The Analysis Step: Job Info, then a Tailored Resume and Question Answers drafted from it. */
async function analysisStep(
  jobDescription: string,
  jobPageData: JobPageData,
  profile: Profile,
  deps: PipelineDeps,
): Promise<Pick<PipelineRunState, 'status' | 'jobInfo' | 'tailoredResume' | 'answers'>> {
  const jobInfo = await deps.backend.extractJob(jobDescription);

  const questions = jobPageData.fields
    .filter((field) => field.category === 'question')
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

  const [tailoredResume, drafted] = await Promise.all([
    deps.backend.tailorResume(profile, jobInfo),
    deps.backend.answerQuestions(profile, jobInfo, forModel),
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

  return { status: 'review', jobInfo, tailoredResume, answers };
}

/**
 * The Fill Step for an already-analyzed run.
 *
 * Takes the run whole rather than five of its fields spread across positional parameters: the run
 * is the unit that crosses this seam anyway, its caller reads it from `lib/tabStore.ts` as one
 * object, and several of those fields shared a type — so a transposed pair type-checked cleanly.
 * {@link AnalyzedRun} carries the precondition (Analysis Step finished) in the type, so it can't be
 * skipped here.
 */
async function fillStep(
  run: AnalyzedRun,
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
  const { jobPageData, jobInfo, tailoredResume, answers, tabUrl } = run;

  // Fill what the page holds *now*, not what it held when the Analysis Step started. The run's own
  // detection is the fallback for a page that can't be re-scanned (no content script — the tab was
  // open across an extension reload), and it's the only source at all for a run analyzed from a
  // pasted job description before the form had rendered, where it is empty.
  // Address the frame that reported the form. If navigation destroyed that frame, retry only this
  // read-only scan as a broadcast and use broadcast addressing for the single fill attempt below.
  // Retrying fill itself would be unsafe: clicks and uploads are not idempotent.
  let frameId = (await getDetectedFrame(tabId))?.frameId;
  let scanned = await deps.page.scan(tabId, frameId);
  if (frameId !== undefined && scanned === null) {
    frameId = undefined;
    scanned = await deps.page.scan(tabId);
  }
  // The fresh scan has the right elements; the analyzed run has the right wording. `carryEnrichment`
  // keeps both — without it the re-scan silently discarded every API-supplied option label and
  // `required` flag, because enrichment only ever attached on the report path, never on `SCAN_PAGE`.
  const fields = scanned?.fields.length
    ? carryEnrichment(scanned.fields, jobPageData.fields)
    : jobPageData.fields;
  const labelByAnalyzedId = new Map(
    jobPageData.fields.map((field) => [field.id, field.label] as const),
  );

  // Analysis may have happened on an ATS overview route before its application questions mounted.
  // The panel normally catches that through live detection, but Fill's fresh scan is authoritative:
  // never write even the scalar fields when a newly-seen question still has no reviewed answer.
  if (
    fields.some(
      (field) =>
        field.category === 'question' &&
        matchAnswerToField(field, answers, labelByAnalyzedId) === undefined,
    )
  ) {
    return {
      status: 'review',
      unresolvedRequiredFields: [],
      filledFieldCount: 0,
      fillOutcome: null,
      jobPageData: { ...jobPageData, fields },
      failure: null,
    };
  }

  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.category === 'question') {
      const answer = matchAnswerToField(field, answers, labelByAnalyzedId);
      if (answer !== undefined) values[field.id] = answer;
      continue;
    }
    const value = valueForCategory(field.category, profile);
    if (value !== undefined) values[field.id] = value;
  }

  // Whether to render a resume at all — not which input it lands on. An ATS can render several
  // `resume_upload`-classified inputs (Ashby pairs an unlabeled decoy with the real, required one),
  // and picking between them needs the live page, so `content/fillForm.ts` does it. This module used
  // to pick one too, purely to decide this boolean, and the two copies of that rule could disagree.
  const needsResume = fields.some((field) => field.category === 'resume_upload');
  // Rendering and filling can outlive a navigation or replacement analysis. Re-check after the
  // awaited scan before either operation can produce an upload or click against the wrong page.
  if ((await getPipelineRun(tabId))?.runId !== run.runId) return null;
  const resume = needsResume
    ? {
        name: resumeFileName(profile.fullName),
        type: 'application/pdf',
        bytes: await deps.backend.renderResumePdf(profile, tailoredResume),
      }
    : undefined;

  // PDF rendering is another await, so the run may have been superseded while it was in flight.
  // Keep this adjacent to the irreversible page command; there is no await between the check and it.
  if ((await getPipelineRun(tabId))?.runId !== run.runId) return null;

  // No frame can own an empty command, so sending it would necessarily return `null` and erase the
  // useful distinction between "no form fields" and "a real fill whose response was lost".
  const filled =
    fields.length === 0
      ? { ok: true as const, filledFieldIds: [], resumeAttached: false }
      : await deps.page.fill(tabId, { fields, values, resume }, frameId);

  // What the page confirmed it kept. A run whose content script didn't answer at all (`null`) has
  // no such account, and falling back to the drafted values is the honest reading there: the fill
  // may well have worked, and reporting every field as unresolved would be its own lie.
  const landed = filled ? new Set(filled.filledFieldIds) : new Set(Object.keys(values));
  const resumeLanded = filled ? filled.resumeAttached : resume !== undefined;

  // A required field is unresolved if this run never drafted a value for it *or* the page didn't
  // keep the one it was given. The second half is the case that used to go unreported: an ATS
  // whose form model discards a programmatic write (see `content/fillForm.ts`) rejects the
  // submission for a field the panel had just shown as filled, leaving the user to work out which
  // one from the ATS's own error banner.
  const unresolvedRequiredFields = fields.filter(
    (field) =>
      field.required &&
      (field.category === 'resume_upload' ? !resumeLanded : !landed.has(field.id)),
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
    status: 'filled',
    unresolvedRequiredFields,
    filledFieldCount,
    fillOutcome,
    jobPageData: { ...jobPageData, fields },
    failure: null,
  };
}

/** Saves the current filled snapshot, creating it once and replacing it after later edits or fills. */
export async function runSaveApplication(
  tabId: number,
  deps: PipelineDeps = productionDeps,
): Promise<void> {
  const run = asAnalyzedRun(
    await transitionPipelineRun(tabId, ['filled', 'save-error'], {
      status: 'saving',
      failure: null,
    }),
  );
  if (!run) return;
  const { runId } = run;

  const payload = {
    company: run.jobInfo.company,
    roleTitle: run.jobInfo.roleTitle,
    jobUrl: run.tabUrl ?? '',
    jobInfo: run.jobInfo,
    tailoredResume: run.tailoredResume,
    answers: run.answers,
  };

  try {
    const application = run.applicationId
      ? await deps.backend.updateApplication(run.applicationId, payload)
      : await deps.backend.saveApplication(payload);
    await patchPipelineRun(tabId, runId, {
      status: 'saved',
      applicationId: application.id,
      failure: null,
    });
  } catch (error) {
    await patchPipelineRun(tabId, runId, {
      status: 'save-error',
      failure: { step: 'save', message: failureMessage(error) },
    });
  }
}

/**
 * The reason to show the user for a failed step — usually a `BackendError` naming the path and
 * status.
 *
 * The steps used to wrap their own failures in an `AnalysisFailedError`/`FillFailedError` whose
 * message was a fixed string, so this had to dig the real cause back out of `.cause`. That wrapping
 * only ever existed to tell "the step failed" apart from "the step's caller has a bug" across the
 * module seam that no longer exists — and letting a bug escape a fire-and-forget `runAnalysis` was
 * never useful anyway: it strands the run in `analyzing` forever with nothing on screen.
 */
function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error ?? 'unknown cause');
}

/**
 * Looks for applications the candidate has already saved for `tabUrl`.
 *
 * Deliberately fails open: the guard exists to save the candidate from re-applying, not to gate
 * their work, and there is no uniqueness constraint on `job_url` making it authoritative anyway. A
 * backend that isn't running must not be the reason Analyze stops working, so a failed lookup is
 * logged and treated as "no duplicates" — which is also why it lives in its own call rather than
 * inside `/extract-job`, where a repository throw would surface as an analysis failure.
 */
async function findDuplicate(
  tabUrl: string | null,
  deps: PipelineDeps,
): Promise<DuplicateApplication | null> {
  if (!tabUrl) return null; // no URL to match on — Chrome hasn't exposed one for this tab

  try {
    const { latest: newest, count } = await deps.backend.findApplicationDuplicates(tabUrl);
    if (!newest) return null;

    return {
      id: newest.id,
      company: newest.company,
      roleTitle: newest.roleTitle,
      createdAt: newest.createdAt,
      count,
    };
  } catch (error) {
    console.warn(`[djobi] duplicate check failed, analyzing anyway: ${failureMessage(error)}`);
    return null;
  }
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

  // Claim the tab before any detection or backend await. Every completion below is scoped to this
  // identity, so a later Analyze click or a navigation can supersede it safely.
  const runId = crypto.randomUUID();
  await setPipelineRun(tabId, {
    runId,
    status: 'analyzing',
    tabUrl,
    jobPageData: { fields: [] },
    jobDescription,
    jobInfo: null,
    tailoredResume: null,
    answers: [],
    unresolvedRequiredFields: [],
    filledFieldCount: 0,
    fillOutcome: null,
    applicationId: null,
    failure: null,
    duplicateOf: null,
  });

  const jobPageData: JobPageData = (await getDetectedPage(tabId)) ?? { fields: [] };
  const duplicateOf = force ? null : await findDuplicate(tabUrl, deps);

  const stillCurrent = await patchPipelineRun(tabId, runId, {
    status: duplicateOf ? 'duplicate' : 'analyzing',
    jobPageData,
    duplicateOf,
  });

  if (!stillCurrent) return;

  // Stop before any backend work: not spending three LLM calls on a posting the candidate has
  // already applied to is the entire point of the check.
  if (duplicateOf) return;

  try {
    await patchPipelineRun(
      tabId,
      runId,
      await analysisStep(jobDescription, jobPageData, profile, deps),
    );
  } catch (error) {
    await patchPipelineRun(tabId, runId, {
      status: 'analyze-error',
      failure: { step: 'analysis', message: failureMessage(error) },
    });
  }
}

/**
 * The statuses a Fill Step may start from — every status the panel's Fill button is reachable and
 * enabled in, which is `reviewOf`'s `canReview` set minus the two it disables the button for.
 *
 * `asAnalyzedRun` alone is not this check: it proves the run *has* an analysis, not that the run is
 * idle. So a `START_FILL` arriving while a fill or a save was already in flight — a duplicate of
 * the step already running, or one dispatched out of sequence — passed straight through and started
 * a second Fill Step against the same tab. `runSaveApplication` has always had the equivalent
 * guard; this is the missing half.
 *
 * Re-filling from `filled` and `saved` is deliberate, not an oversight: a candidate may re-fill
 * after editing an answer, and the Save Step updates the same record rather than creating a second.
 *
 * The transition into `filling` happens atomically in `transitionPipelineRun`, so two commands that
 * arrive together cannot both claim the same run.
 */
const FILLABLE_FROM: readonly PipelineStatus[] = [
  'review',
  'fill-error',
  'filled',
  'save-error',
  'saved',
];

export async function runFill(
  tabId: number,
  profile: Profile,
  deps: PipelineDeps = productionDeps,
): Promise<void> {
  const run = asAnalyzedRun(
    await transitionPipelineRun(tabId, FILLABLE_FROM, { status: 'filling', failure: null }),
  );
  if (!run) return;
  const { runId } = run;

  try {
    const result = await fillStep(run, profile, tabId, deps);
    if (result) await patchPipelineRun(tabId, runId, result);
  } catch (error) {
    await patchPipelineRun(tabId, runId, {
      status: 'fill-error',
      failure: { step: 'fill', message: failureMessage(error) },
    });
  }
}
