import type {
  DetectedField,
  JobInfo,
  NewApplication,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import type { JobPageData } from '../lib/messages';

export interface PipelineDeps {
  extractJob: (pageText: string) => Promise<JobInfo>;
  tailorResume: (profile: Profile, jobInfo: JobInfo) => Promise<TailoredResume>;
  answerQuestions: (
    profile: Profile,
    jobInfo: JobInfo,
    questions: { fieldId: string; question: string; options?: string[] }[],
  ) => Promise<QuestionAnswer[]>;
  fetchResumePdf: (profile: Profile, tailoredResume: TailoredResume) => Promise<ArrayBuffer>;
  sendFillFormMessage: (message: unknown) => Promise<unknown>;
  saveApplication: (payload: NewApplication) => Promise<unknown>;
}

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
  deps: PipelineDeps,
): Promise<{ jobInfo: JobInfo; tailoredResume: TailoredResume; answers: QuestionAnswer[] }> {
  try {
    const jobInfo = await deps.extractJob(jobPageData.pageText);

    const questions = jobPageData.fields
      .filter((field) => field.category === 'question')
      .map((field) => ({ fieldId: field.id, question: field.label, options: field.options }));

    const [tailoredResume, answers] = await Promise.all([
      deps.tailorResume(profile, jobInfo),
      deps.answerQuestions(profile, jobInfo, questions),
    ]);

    return { jobInfo, tailoredResume, answers };
  } catch (error) {
    throw new AnalysisFailedError(error);
  }
}

export async function fillAndSubmit(
  jobPageData: JobPageData,
  profile: Profile,
  jobInfo: JobInfo,
  tailoredResume: TailoredResume,
  answers: QuestionAnswer[],
  tabId: number,
  tabUrl: string | null,
  deps: PipelineDeps,
): Promise<{ unresolvedRequiredFields: DetectedField[] }> {
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
        name: 'resume.pdf',
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

    return { unresolvedRequiredFields };
  } catch (error) {
    throw new FillFailedError(error);
  }
}
