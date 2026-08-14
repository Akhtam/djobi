/**
 * The Application Pipeline: the Analysis Step and the Fill Step, and the checkpointing of both into
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
  getDetectedPage,
  getPipelineRun,
  patchPipelineRun,
  setPipelineRun,
  type AnalyzedRun,
  type PipelineRunState,
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
): Promise<
  Pick<PipelineRunState, 'status' | 'unresolvedRequiredFields' | 'filledFieldCount' | 'jobPageData'>
> {
  const { jobPageData, jobInfo, tailoredResume, answers, tabUrl } = run;

  // Fill what the page holds *now*, not what it held when the Analysis Step started. The run's own
  // detection is the fallback for a page that can't be re-scanned (no content script — the tab was
  // open across an extension reload), and it's the only source at all for a run analyzed from a
  // pasted job description before the form had rendered, where it is empty.
  const scanned = await deps.page.scan(tabId);
  // The fresh scan has the right elements; the analyzed run has the right wording. `carryEnrichment`
  // keeps both — without it the re-scan silently discarded every API-supplied option label and
  // `required` flag, because enrichment only ever attached on the report path, never on `SCAN_PAGE`.
  const fields = scanned?.fields.length
    ? carryEnrichment(scanned.fields, jobPageData.fields)
    : jobPageData.fields;
  const labelByAnalyzedId = new Map(
    jobPageData.fields.map((field) => [field.id, field.label] as const),
  );

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
  // and picking between them needs the live page, so `content/index.ts` does it. This module used
  // to pick one too, purely to decide this boolean, and the two copies of that rule could disagree.
  const needsResume = fields.some((field) => field.category === 'resume_upload');
  const resume = needsResume
    ? {
        name: resumeFileName(profile.fullName),
        type: 'application/pdf',
        bytes: await deps.backend.renderResumePdf(profile, tailoredResume),
      }
    : undefined;

  const filled = await deps.page.fill(tabId, { fields, values, resume });

  await deps.backend.saveApplication({
    company: jobInfo.company,
    roleTitle: jobInfo.roleTitle,
    jobUrl: tabUrl ?? '',
    jobInfo,
    tailoredResume,
    answers,
    status: 'draft',
  });

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

  // The re-scan is checkpointed back onto the run so the panel reports what was actually filled —
  // `unresolvedRequiredFields` above is derived from these fields, and the panel lists them.
  return {
    status: 'filled',
    unresolvedRequiredFields,
    filledFieldCount,
    jobPageData: { ...jobPageData, fields },
  };
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
 * Starts a run: analyzes `jobDescription` and drafts everything the Fill Step will write.
 *
 * `jobDescription` is the candidate's pasted posting, and it is the only thing analyzed. The page
 * is consulted solely for the *form* — which fields exist to be filled — and a tab with no
 * detection yet still analyzes fine, because the Fill Step re-scans the live page anyway.
 */
export async function runAnalysis(
  tabId: number,
  tabUrl: string | null,
  profile: Profile,
  jobDescription: string,
  deps: PipelineDeps = productionDeps,
): Promise<void> {
  if (!jobDescription.trim()) return; // nothing to analyze — mirrors the panel's own guard

  const jobPageData: JobPageData = (await getDetectedPage(tabId)) ?? { fields: [] };

  await setPipelineRun(tabId, {
    status: 'analyzing',
    tabUrl,
    jobPageData,
    jobDescription,
    jobInfo: null,
    tailoredResume: null,
    answers: [],
    unresolvedRequiredFields: [],
    filledFieldCount: 0,
    failure: null,
  });

  try {
    await patchPipelineRun(tabId, await analysisStep(jobDescription, jobPageData, profile, deps));
  } catch (error) {
    await patchPipelineRun(tabId, {
      status: 'analyze-error',
      failure: { step: 'analysis', message: failureMessage(error) },
    });
  }
}

export async function runFill(
  tabId: number,
  profile: Profile,
  deps: PipelineDeps = productionDeps,
): Promise<void> {
  const run = asAnalyzedRun(await getPipelineRun(tabId));
  if (!run) return;

  await patchPipelineRun(tabId, { status: 'filling', failure: null });

  try {
    await patchPipelineRun(tabId, await fillStep(run, profile, tabId, deps));
  } catch (error) {
    await patchPipelineRun(tabId, {
      status: 'fill-error',
      failure: { step: 'fill', message: failureMessage(error) },
    });
  }
}
