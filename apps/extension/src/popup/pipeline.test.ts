import type { DetectedField, JobInfo, Profile, QuestionAnswer, TailoredResume } from '@djobi/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisFailedError,
  analyzeJobPage,
  FillFailedError,
  fillAndSubmit,
  type PipelineDeps,
} from './pipeline';

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

const tailoredResume: TailoredResume = {
  summary: 'Tailored summary.',
  skills: [],
  workExperience: [],
};

const questionField: DetectedField = {
  id: 'f-why',
  label: 'Why do you want to work here?',
  inputType: 'textarea',
  selector: '#why-field',
  category: 'question',
};

const answers: QuestionAnswer[] = [
  { fieldId: 'f-why', question: 'Why do you want to work here?', answer: 'Draft answer.', sourceStoryIds: [] },
];

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    extractJob: vi.fn().mockResolvedValue(jobInfo),
    tailorResume: vi.fn().mockResolvedValue(tailoredResume),
    answerQuestions: vi.fn().mockResolvedValue(answers),
    fetchResumePdf: vi.fn(),
    sendFillFormMessage: vi.fn(),
    saveApplication: vi.fn(),
    ...overrides,
  };
}

describe('analyzeJobPage', () => {
  it('extracts job info, then tailors a resume and drafts answers from it', async () => {
    const deps = makeDeps();
    const jobPageData = { pageText: 'Senior Engineer at Acme...', fields: [questionField] };

    const result = await analyzeJobPage(jobPageData, profile, deps);

    expect(deps.extractJob).toHaveBeenCalledWith('Senior Engineer at Acme...');
    expect(deps.tailorResume).toHaveBeenCalledWith(profile, jobInfo);
    expect(deps.answerQuestions).toHaveBeenCalledWith(profile, jobInfo, [
      { fieldId: 'f-why', question: 'Why do you want to work here?' },
    ]);
    expect(result).toEqual({ jobInfo, tailoredResume, answers });
  });

  it('wraps an underlying failure in AnalysisFailedError, preserving the cause', async () => {
    const underlying = new Error('backend unreachable');
    const deps = makeDeps({ extractJob: vi.fn().mockRejectedValue(underlying) });
    const jobPageData = { pageText: 'Senior Engineer at Acme...', fields: [] };

    await expect(analyzeJobPage(jobPageData, profile, deps)).rejects.toThrow(AnalysisFailedError);
    await expect(analyzeJobPage(jobPageData, profile, deps)).rejects.toMatchObject({
      cause: underlying,
    });
  });
});

describe('fillAndSubmit', () => {
  const emailField: DetectedField = {
    id: 'f-email',
    label: 'Email',
    inputType: 'email',
    selector: '#email-field',
    category: 'email',
  };

  it('fills scalar and question fields, then saves the application, without touching the resume', async () => {
    const deps = makeDeps();
    const jobPageData = { pageText: '...', fields: [emailField, questionField] };

    await fillAndSubmit(
      jobPageData,
      profile,
      jobInfo,
      tailoredResume,
      answers,
      1,
      'https://boards.greenhouse.io/acme/jobs/1',
      deps,
    );

    expect(deps.fetchResumePdf).not.toHaveBeenCalled();
    expect(deps.sendFillFormMessage).toHaveBeenCalledWith({
      type: 'FILL_FORM',
      tabId: 1,
      fields: jobPageData.fields,
      values: { 'f-email': 'jane@example.com', 'f-why': 'Draft answer.' },
      resumeFile: undefined,
    });
    expect(deps.saveApplication).toHaveBeenCalledWith({
      company: 'Acme',
      roleTitle: 'Senior Engineer',
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      jobInfo,
      tailoredResume,
      answers,
      status: 'draft',
    });
  });

  it('fetches and attaches the tailored resume PDF when a resume_upload field is present', async () => {
    const resumeField: DetectedField = {
      id: 'f-resume',
      label: 'Resume',
      inputType: 'file',
      selector: '#resume-field',
      category: 'resume_upload',
    };
    const pdfBytes = new Uint8Array([37, 80, 68, 70]).buffer;
    const deps = makeDeps({ fetchResumePdf: vi.fn().mockResolvedValue(pdfBytes) });
    const jobPageData = { pageText: '...', fields: [resumeField] };

    await fillAndSubmit(jobPageData, profile, jobInfo, tailoredResume, answers, 1, null, deps);

    expect(deps.fetchResumePdf).toHaveBeenCalledWith(profile, tailoredResume);
    expect(deps.sendFillFormMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeFile: { name: 'resume.pdf', type: 'application/pdf', bytes: [37, 80, 68, 70] },
      }),
    );
  });

  it('wraps an underlying failure in FillFailedError, preserving the cause', async () => {
    const underlying = new Error('backend unreachable');
    const deps = makeDeps({ sendFillFormMessage: vi.fn().mockRejectedValue(underlying) });
    const jobPageData = { pageText: '...', fields: [emailField] };

    await expect(
      fillAndSubmit(jobPageData, profile, jobInfo, tailoredResume, answers, 1, null, deps),
    ).rejects.toThrow(FillFailedError);
    await expect(
      fillAndSubmit(jobPageData, profile, jobInfo, tailoredResume, answers, 1, null, deps),
    ).rejects.toMatchObject({ cause: underlying });
  });
});
