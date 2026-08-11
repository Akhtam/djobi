import type { JobInfo, Profile, QuestionAnswer } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAnswerQuestions } = vi.hoisted(() => ({ mockAnswerQuestions: vi.fn() }));

vi.mock('../llm/answerQuestions.js', () => ({
  answerQuestions: mockAnswerQuestions,
}));

const { app } = await import('../app.js');

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: ['TypeScript'],
  stories: [],
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
    mockAnswerQuestions.mockReset();
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
    expect(mockAnswerQuestions).toHaveBeenCalledWith(sampleProfile, sampleJobInfo, sampleQuestions);
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
      sampleProfile,
      sampleJobInfo,
      questionsWithOptions,
    );
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
