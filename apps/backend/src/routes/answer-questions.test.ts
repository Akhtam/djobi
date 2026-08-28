import type { JobInfo, Profile, QuestionAnswer } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAnswerQuestions } = vi.hoisted(() => ({ mockAnswerQuestions: vi.fn() }));

vi.mock('../llm/answerQuestions.js', () => ({
  answerQuestions: mockAnswerQuestions,
}));

const { app } = await import('../app.js');
const { StructuredCallError } = await import('../llm/structuredCall.js');

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: ['TypeScript'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};
const answerProfile = {
  workExperience: sampleProfile.workExperience,
  education: sampleProfile.education,
  skills: sampleProfile.skills,
  stories: sampleProfile.stories,
  customAnswers: sampleProfile.customAnswers,
};

const sampleJobInfo: JobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: ['TypeScript', 'Postgres'],
};

const sampleQuestions = [{ fieldId: 'q1', question: 'Why do you want to work here?' }];

const sampleAnswers: QuestionAnswer[] = [
  {
    fieldId: 'q1',
    question: 'Why do you want to work here?',
    answer: 'Because I love TypeScript.',
    sourceStoryIds: [],
  },
];

describe('POST /answer-questions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAnswerQuestions.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the drafted answers for a valid request', async () => {
    mockAnswerQuestions.mockResolvedValue(sampleAnswers);

    const res = await app.request('/answer-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: sampleProfile,
        jobInfo: sampleJobInfo,
        questions: sampleQuestions,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleAnswers);
    expect(mockAnswerQuestions).toHaveBeenCalledWith(
      answerProfile,
      sampleJobInfo,
      sampleQuestions,
      expect.any(AbortSignal),
    );
  });

  it('accepts a question with options and passes it through unchanged', async () => {
    mockAnswerQuestions.mockResolvedValue(sampleAnswers);
    const questionsWithOptions = [
      { fieldId: 'q1', question: 'Are you authorized to work in the US?', options: ['Yes', 'No'] },
    ];

    const res = await app.request('/answer-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: sampleProfile,
        jobInfo: sampleJobInfo,
        questions: questionsWithOptions,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockAnswerQuestions).toHaveBeenCalledWith(
      answerProfile,
      sampleJobInfo,
      questionsWithOptions,
      expect.any(AbortSignal),
    );
  });

  it('carries knownAnswer through to answerQuestions, since the prompt treats it as binding fact', async () => {
    // The regression this pins: the route used to declare its own question schema without
    // `knownAnswer`, and zod's `.object()` strips unknown keys — so the fact the profile held was
    // silently deleted here and the model decided a work-authorization declaration on its own.
    mockAnswerQuestions.mockResolvedValue(sampleAnswers);
    const questionsWithKnownAnswer = [
      {
        fieldId: 'q1',
        question: 'Will you now or in the future require sponsorship?',
        options: [
          'I do not require sponsorship now or in the future',
          'I will require sponsorship',
        ],
        knownAnswer: 'No',
      },
    ];

    const res = await app.request('/answer-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: sampleProfile,
        jobInfo: sampleJobInfo,
        questions: questionsWithKnownAnswer,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockAnswerQuestions).toHaveBeenCalledWith(
      answerProfile,
      sampleJobInfo,
      questionsWithKnownAnswer,
      expect.any(AbortSignal),
    );
  });

  it('reports an abandoned request as 499 and logs nothing, so a closed panel is not a backend fault', async () => {
    // The candidate closed the panel or hit Re-analyze. The model calls were aborted on purpose, so
    // this is not a failure — and routing it through console.error is what makes the channel that
    // means "the backend is broken" not worth reading.
    mockAnswerQuestions.mockRejectedValue(new Error('Request was aborted.'));
    const controller = new AbortController();
    controller.abort();

    const res = await app.request('/answer-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: sampleProfile,
        jobInfo: sampleJobInfo,
        questions: [{ fieldId: 'f1', question: 'Why us?' }],
      }),
      signal: controller.signal,
    });

    expect(res.status).toBe(499);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('returns 500 with a JSON body but does not expose the internal cause to the client', async () => {
    mockAnswerQuestions.mockRejectedValueOnce(
      new StructuredCallError(
        'no-tool-call',
        'report_answers',
        'report_answers did not produce a tool call.',
        'req-final',
        false,
        'refusal',
      ),
    );

    const res = await app.request('/answer-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: sampleProfile,
        jobInfo: sampleJobInfo,
        questions: [{ fieldId: 'f1', question: 'Why us?' }],
      }),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({
      error: 'Internal server error',
    });
    expect(console.error).toHaveBeenCalledWith('[djobi] POST /answer-questions failed', {
      name: 'StructuredCallError',
      message: 'report_answers did not produce a tool call.',
      kind: 'no-tool-call',
      toolName: 'report_answers',
      requestId: 'req-final',
      stopReason: 'refusal',
    });
  });

  it('returns 400 and does not call answerQuestions when the body fails validation', async () => {
    const res = await app.request('/answer-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(res.status).toBe(400);
    expect(mockAnswerQuestions).not.toHaveBeenCalled();
  });
});
