import { resumeFileName } from '@djobi/shared';
import type {
  DetectedField,
  JobInfo,
  NewApplication,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import type { JobPageData } from '../lib/messages';
import type { AnalyzedRun } from '../lib/tabStore';

/** What the Analysis Step needs — and nothing else, so a test for it stubs only these three. */
export interface AnalysisDeps {
  extractJob: (pageText: string) => Promise<JobInfo>;
  tailorResume: (profile: Profile, jobInfo: JobInfo) => Promise<TailoredResume>;
  answerQuestions: (
    profile: Profile,
    jobInfo: JobInfo,
    questions: { fieldId: string; question: string; options?: string[] }[],
  ) => Promise<QuestionAnswer[]>;
}

/** What the Fill Step needs — likewise only these three. */
export interface FillDeps {
  fetchResumePdf: (profile: Profile, tailoredResume: TailoredResume) => Promise<ArrayBuffer>;
  sendFillFormMessage: (message: unknown) => Promise<unknown>;
  saveApplication: (payload: NewApplication) => Promise<unknown>;
}

/** The whole Application Pipeline's dependencies — what the single background adapter supplies. */
export type PipelineDeps = AnalysisDeps & FillDeps;

export class AnalysisFailedError extends Error {
  constructor(cause: unknown) {
    super('Failed to analyze the job page.', { cause });
    this.name = 'AnalysisFailedError';
  }
}

export class FillFailedError extends Error {
  constructor(cause: unknown) {
    super('Failed to fill and save the application.', { cause });
    this.name = 'FillFailedError';
  }
}

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

export async function analyzeJobPage(
  jobPageData: JobPageData,
  profile: Profile,
  deps: AnalysisDeps,
): Promise<{ jobInfo: JobInfo; tailoredResume: TailoredResume; answers: QuestionAnswer[] }> {
  try {
    const jobInfo = await deps.extractJob(jobPageData.pageText);

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

    const [tailoredResume, answers] = await Promise.all([
      deps.tailorResume(profile, jobInfo),
      deps.answerQuestions(profile, jobInfo, questions),
    ]);

    return { jobInfo, tailoredResume, answers };
  } catch (error) {
    throw new AnalysisFailedError(error);
  }
}

/**
 * Runs the Fill Step for an already-analyzed run.
 *
 * Takes the run whole rather than five of its fields spread across positional parameters: the run
 * is the unit that crosses this seam anyway, its caller reads it from `lib/tabStore.ts` as one
 * object, and several of those fields shared a type — so a transposed pair type-checked cleanly.
 * {@link AnalyzedRun} carries the precondition (Analysis Step finished) in the type, so it can't be
 * skipped here.
 */
export async function fillAndSubmit(
  run: AnalyzedRun,
  profile: Profile,
  tabId: number,
  deps: FillDeps,
): Promise<{ unresolvedRequiredFields: DetectedField[]; filledFieldCount: number }> {
  const { jobPageData, jobInfo, tailoredResume, answers, tabUrl } = run;

  try {
    const values: Record<string, string> = {};
    for (const field of jobPageData.fields) {
      if (field.category === 'question') {
        const answer = answers.find((a) => a.fieldId === field.id);
        if (answer) values[field.id] = answer.answer;
        continue;
      }
      const value = valueForCategory(field.category, profile);
      if (value !== undefined) values[field.id] = value;
    }

    // Some ATS platforms (e.g. Ashby) render more than one `resume_upload`-classified file input —
    // an unlabeled/decoy one alongside the real, required one. Prefer the required field so the
    // resume doesn't end up attached to the wrong (non-required, likely inert) input.
    const resumeUploadField =
      jobPageData.fields.find((field) => field.category === 'resume_upload' && field.required) ??
      jobPageData.fields.find((field) => field.category === 'resume_upload');
    let resumeFile: { name: string; type: string; bytes: number[] } | undefined;
    if (resumeUploadField) {
      const pdfBytes = await deps.fetchResumePdf(profile, tailoredResume);
      resumeFile = {
        name: resumeFileName(profile.fullName),
        type: 'application/pdf',
        bytes: Array.from(new Uint8Array(pdfBytes)),
      };
    }

    await deps.sendFillFormMessage({
      type: 'FILL_FORM',
      tabId,
      fields: jobPageData.fields,
      values,
      resumeFile,
    });

    await deps.saveApplication({
      company: jobInfo.company,
      roleTitle: jobInfo.roleTitle,
      jobUrl: tabUrl ?? '',
      jobInfo,
      tailoredResume,
      answers,
      status: 'draft',
    });

    const unresolvedRequiredFields = jobPageData.fields.filter(
      (field) =>
        field.required &&
        values[field.id] === undefined &&
        !(field.category === 'resume_upload' && resumeFile),
    );

    // How much this run actually wrote. `unresolvedRequiredFields` can't answer that on its own:
    // it's derived by filtering `jobPageData.fields`, so a run that detected nothing at all
    // produces an empty list — indistinguishable from a run that filled everything perfectly, and
    // the panel rendered both as an unqualified success. The resume counts as a filled field
    // because it's attached by `attachResumeFile` rather than through `values`.
    const filledFieldCount = Object.keys(values).length + (resumeFile ? 1 : 0);

    return { unresolvedRequiredFields, filledFieldCount };
  } catch (error) {
    throw new FillFailedError(error);
  }
}
