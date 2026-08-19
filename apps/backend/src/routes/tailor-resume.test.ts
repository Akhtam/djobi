import type { JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTailorResume } = vi.hoisted(() => ({ mockTailorResume: vi.fn() }));

vi.mock('../llm/tailorResume.js', () => ({
  tailorResume: mockTailorResume,
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
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
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

const sampleTailoredResume: TailoredResume = {
  skills: ['TypeScript'],
  workExperience: [],
};

describe('POST /tailor-resume', () => {
  beforeEach(() => {
    mockTailorResume.mockReset();
  });

  it('returns the tailored resume for a valid request', async () => {
    mockTailorResume.mockResolvedValue(sampleTailoredResume);

    const res = await app.request('/tailor-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleTailoredResume);
    expect(mockTailorResume).toHaveBeenCalledWith(
      { workExperience: sampleProfile.workExperience, skills: sampleProfile.skills },
      sampleJobInfo,
    );
  });

  it('returns 400 and does not call tailorResume when the body fails validation', async () => {
    const res = await app.request('/tailor-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile }),
    });

    expect(res.status).toBe(400);
    expect(mockTailorResume).not.toHaveBeenCalled();
  });
});
