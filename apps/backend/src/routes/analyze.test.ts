import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAnalyzeApplication } = vi.hoisted(() => ({ mockAnalyzeApplication: vi.fn() }));

vi.mock('../llm/analyzeApplication.js', () => ({
  analyzeApplication: mockAnalyzeApplication,
}));

const { createTestApp } = await import('../testApp.js');

// This route touches no store; the in-memory ones exist only so the app can be built.
const { app } = createTestApp();

const sampleProfile = {
  workExperience: [],
  education: [],
  maxBulletsPerRole: 6,
  skills: ['TypeScript'],
  stories: [],
  customAnswers: [],
};

const sampleResult = {
  jobInfo: {
    company: 'Acme',
    team: 'Platform',
    roleTitle: 'Senior Software Engineer',
    seniority: 'Senior',
    location: 'Remote',
    requirements: [],
    keywords: [],
  },
  tailoredResume: { skills: ['TypeScript'], workExperience: [] },
  answers: [{ fieldId: 'f-why', question: 'Why us?', answer: 'Because.', sourceStoryIds: [] }],
};

describe('POST /analyze', () => {
  beforeEach(() => {
    mockAnalyzeApplication.mockReset();
  });

  it('returns the combined analysis for a valid request', async () => {
    mockAnalyzeApplication.mockResolvedValue(sampleResult);

    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobDescription: 'Senior Software Engineer at Acme...',
        profile: sampleProfile,
        questions: [{ fieldId: 'f-why', question: 'Why us?' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleResult);
    expect(mockAnalyzeApplication).toHaveBeenCalledWith(
      'Senior Software Engineer at Acme...',
      sampleProfile,
      [{ fieldId: 'f-why', question: 'Why us?' }],
      expect.any(AbortSignal),
    );
  });

  it('returns 400 when jobDescription is empty', async () => {
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobDescription: '', profile: sampleProfile, questions: [] }),
    });

    expect(res.status).toBe(400);
    expect(mockAnalyzeApplication).not.toHaveBeenCalled();
  });

  it('returns 400 when the profile carries a field neither model call grounds itself in', async () => {
    // `AnalyzeApplicationProfileSchema` is `.pick` over `ProfileSchema`, not `.strict()`, so an
    // extra field is silently stripped rather than rejected — the same behaviour
    // `TailorResumeRequestSchema`/`AnswerQuestionsRequestSchema` already rely on. This pins that a
    // required field's absence is still a 400, which is the half a silent-strip test can't show.
    const res = await app.request('/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobDescription: 'Senior Software Engineer at Acme...',
        profile: { ...sampleProfile, skills: undefined },
        questions: [],
      }),
    });

    expect(res.status).toBe(400);
    expect(mockAnalyzeApplication).not.toHaveBeenCalled();
  });

  it('strips a field neither model call grounds itself in, rather than sending it on', async () => {
    mockAnalyzeApplication.mockResolvedValue(sampleResult);

    await app.request('/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobDescription: 'Senior Software Engineer at Acme...',
        profile: { ...sampleProfile, phone: '555-0100', screeningAnswers: { relocation: 'Yes' } },
        questions: [],
      }),
    });

    expect(mockAnalyzeApplication).toHaveBeenCalledWith(
      'Senior Software Engineer at Acme...',
      sampleProfile,
      [],
      expect.any(AbortSignal),
    );
  });
});
