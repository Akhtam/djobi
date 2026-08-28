import type { JobInfo, Profile, RequirementFit } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAssessRequirements } = vi.hoisted(() => ({ mockAssessRequirements: vi.fn() }));

vi.mock('../llm/assessRequirements.js', () => ({
  assessRequirements: mockAssessRequirements,
}));

const { app } = await import('../app.js');

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: ['TypeScript'],
  stories: [
    { id: 's-1', title: 'A story', tags: [], situation: '', task: '', action: '', result: '' },
  ],
  screeningAnswers: { sponsorship_required: 'No' },
  customAnswers: [],
};

const sampleJobInfo: JobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: [],
};

const sampleFit: RequirementFit[] = [
  {
    requirement: '5+ years of backend experience',
    verdict: 'unmet',
    evidence: null,
    note: 'Your profile shows three.',
  },
];

describe('POST /assess-requirements', () => {
  beforeEach(() => {
    mockAssessRequirements.mockReset();
  });

  it('returns the assessment wrapped in an object, so the response shape can grow without breaking readers', async () => {
    mockAssessRequirements.mockResolvedValue(sampleFit);

    const res = await app.request('/assess-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fit: sampleFit });
  });

  it('sends only the profile fields a qualification judgement needs — screening answers are legal declarations and never grounding for a model', async () => {
    mockAssessRequirements.mockResolvedValue([]);

    await app.request('/assess-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(mockAssessRequirements).toHaveBeenCalledWith(
      {
        workExperience: sampleProfile.workExperience,
        education: sampleProfile.education,
        skills: sampleProfile.skills,
      },
      sampleJobInfo,
    );
  });

  it('returns 400 and does not call the model when the body fails validation', async () => {
    const res = await app.request('/assess-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile }),
    });

    expect(res.status).toBe(400);
    expect(mockAssessRequirements).not.toHaveBeenCalled();
  });

  it('returns 415 for a request that does not declare JSON, like every other state-changing route', async () => {
    const res = await app.request('/assess-requirements', {
      method: 'POST',
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(res.status).toBe(415);
    expect(mockAssessRequirements).not.toHaveBeenCalled();
  });
});
