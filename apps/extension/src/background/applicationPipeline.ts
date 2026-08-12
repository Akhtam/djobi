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
import { labelsMatch, resumeFileName, splitPreparedQuestions } from '@djobi/shared';
import type {
  DetectedField,
  JobInfo,
  NewApplication,
  Profile,
  QuestionAnswer,
  QuestionForModel,
  TailoredResume,
} from '@djobi/shared';
import { callBackend, callBackendBinary } from '../lib/callBackend';
import type {
  FillFormCommandMessage,
  FillFormResult,
  JobPageData,
  ScanPageCommandMessage,
} from '../lib/messages';
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
 * What the Fill Step asks the page to do, in the pipeline's own terms: the fields, the values to
 * write, and the resume to attach as raw bytes.
 *
 * Deliberately not the `FILL_FORM` wire message. That message carries its bytes as `number[]`,
 * because `chrome.runtime` messaging can't carry an `ArrayBuffer` — a transport detail that has no
 * business in the step deciding *what* to fill. Naming which upload input receives the file is
 * likewise absent: `content/index.ts` owns that choice, being the only side that can see the page.
 */
export interface FillPageCommand {
  fields: DetectedField[];
  values: Record<string, string>;
  resume?: { name: string; type: string; bytes: ArrayBuffer };
}

/** Everything the Application Pipeline reaches outside itself for — the seam a test replaces whole. */
export interface PipelineDeps {
  extractJob: (jobDescription: string) => Promise<JobInfo>;
  tailorResume: (profile: Profile, jobInfo: JobInfo) => Promise<TailoredResume>;
  answerQuestions: (
    profile: Profile,
    jobInfo: JobInfo,
    questions: QuestionForModel[],
  ) => Promise<QuestionAnswer[]>;
  renderResumePdf: (profile: Profile, tailoredResume: TailoredResume) => Promise<ArrayBuffer>;
  /**
   * Fills the tab's form, resolving with the page's own account of what landed — or `null` when no
   * frame answers (no content script, or a content script orphaned by an extension reload), which
   * the caller must not read as "nothing was filled".
   */
  fillPage: (tabId: number, command: FillPageCommand) => Promise<FillFormResult | null>;
  /** Re-scans the tab's live form, or resolves `null` when no frame answers (no content script, no form). */
  scanPage: (tabId: number) => Promise<JobPageData | null>;
  saveApplication: (payload: NewApplication) => Promise<unknown>;
}

/** The production adapter: the local backend for the four calls, and the tab's content script for the fill. */
const backendDeps: PipelineDeps = {
  extractJob: (jobDescription) => callBackend('/extract-job', { jobDescription }),
  tailorResume: (profile, jobInfo) => callBackend('/tailor-resume', { profile, jobInfo }),
  answerQuestions: (profile, jobInfo, questions) =>
    callBackend('/answer-questions', { profile, jobInfo, questions }),
  renderResumePdf: (profile, tailoredResume) =>
    callBackendBinary('/render-resume-pdf', { profile, tailoredResume }),
  fillPage: (tabId, command) =>
    new Promise((resolve) => {
      const message: FillFormCommandMessage = {
        type: 'FILL_FORM',
        fields: command.fields,
        values: command.values,
        // The wire can only carry plain JSON, so the bytes are encoded here, at the edge that
        // actually has the constraint.
        resumeFile: command.resume && {
          name: command.resume.name,
          type: command.resume.type,
          bytes: Array.from(new Uint8Array(command.resume.bytes)),
        },
      };
      chrome.tabs.sendMessage(tabId, message, (response?: FillFormResult) => {
        // Reading `lastError` marks it handled; an unanswered message would otherwise log as an
        // unchecked runtime error. Same rule as `scanPage` below.
        void chrome.runtime.lastError;
        resolve(response ?? null);
      });
    }),
  scanPage: (tabId) =>
    new Promise((resolve) => {
      const message: ScanPageCommandMessage = { type: 'SCAN_PAGE' };
      chrome.tabs.sendMessage(tabId, message, (response?: JobPageData) => {
        // Reading `lastError` is what marks it handled; an unanswered message (no content script in
        // the tab, or no frame holding a form) would otherwise log as an unchecked runtime error.
        void chrome.runtime.lastError;
        resolve(response ?? null);
      });
    }),
  saveApplication: (payload) => callBackend('/applications', payload),
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
  const jobInfo = await deps.extractJob(jobDescription);

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
    deps.tailorResume(profile, jobInfo),
    deps.answerQuestions(profile, jobInfo, forModel),
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
 * The drafted answer for a freshly-scanned field.
 *
 * By field id first — `detectFields.ts` keeps an element's id stable across scans, so this is the
 * normal path. By question text second, for the field that was re-tagged anyway: an element the
 * Analysis Step saw can be unmounted and remounted by the ATS between analyzing and filling
 * (expanding a section, a conditional question re-rendering), which loses its `data-djobi-id` and
 * hands it a new one. The answer was drafted for that *question*, so the question is what identifies
 * it once the id can't.
 *
 * That second path insists the match be *unambiguous*. Labels are not reliably unique — a form
 * whose labels degrade to a shared placeholder (Ashby renders "Start typing…" on every combobox)
 * gives several fields the same one, and matching the first would put one field's answer into
 * whichever of them happened to be re-tagged. An ambiguous label is treated as no match at all,
 * leaving the field to be reported as unresolved rather than confidently filled with the wrong text.
 */
function answerForField(
  field: DetectedField,
  answers: QuestionAnswer[],
  labelByAnalyzedId: Map<string, string>,
): string | undefined {
  const byId = answers.find((answer) => answer.fieldId === field.id);
  if (byId) return byId.answer;

  if (!field.label) return undefined;

  const byLabel = answers.filter((answer) => {
    const label = labelByAnalyzedId.get(answer.fieldId);
    return label ? labelsMatch(label, field.label) : false;
  });

  return byLabel.length === 1 ? byLabel[0].answer : undefined;
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
  const scanned = await deps.scanPage(tabId);
  const fields = scanned?.fields.length ? scanned.fields : jobPageData.fields;
  const labelByAnalyzedId = new Map(
    jobPageData.fields.map((field) => [field.id, field.label] as const),
  );

  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.category === 'question') {
      const answer = answerForField(field, answers, labelByAnalyzedId);
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
        bytes: await deps.renderResumePdf(profile, tailoredResume),
      }
    : undefined;

  const filled = await deps.fillPage(tabId, { fields, values, resume });

  await deps.saveApplication({
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
  deps: PipelineDeps = backendDeps,
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
  deps: PipelineDeps = backendDeps,
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
