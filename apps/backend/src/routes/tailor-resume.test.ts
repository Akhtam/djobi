import type { Application, JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTailorResume, mockListApplicationsByCompany } = vi.hoisted(() => ({
  mockTailorResume: vi.fn(),
  mockListApplicationsByCompany: vi.fn(),
}));

vi.mock('../llm/tailorResume.js', () => ({
  tailorResume: mockTailorResume,
}));

vi.mock('../db/applicationsRepository.js', () => ({
  listApplicationsByCompany: mockListApplicationsByCompany,
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

const priorApplication: Application = {
  id: 'application-1',
  company: 'Acme',
  roleTitle: 'Backend Engineer',
  jobUrl: 'https://acme.com/jobs/1',
  jobInfo: sampleJobInfo,
  tailoredResume: sampleTailoredResume,
  answers: [],
  status: 'submitted',
  createdAt: '2026-07-01T00:00:00.000Z',
};

describe('POST /tailor-resume', () => {
  beforeEach(() => {
    mockTailorResume.mockReset();
    mockListApplicationsByCompany.mockReset();
  });

  it('returns the tailored resume for a valid request', async () => {
    mockListApplicationsByCompany.mockResolvedValue([]);
    mockTailorResume.mockResolvedValue(sampleTailoredResume);

    const res = await app.request('/tailor-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleTailoredResume);
    expect(mockListApplicationsByCompany).toHaveBeenCalledWith('Acme');
    expect(mockTailorResume).toHaveBeenCalledWith(sampleProfile, sampleJobInfo, undefined);
  });

  it('passes a summary of prior applications to the same company', async () => {
    mockListApplicationsByCompany.mockResolvedValue([priorApplication]);
    mockTailorResume.mockResolvedValue(sampleTailoredResume);

    const res = await app.request('/tailor-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(res.status).toBe(200);
    expect(mockTailorResume).toHaveBeenCalledWith(
      sampleProfile,
      sampleJobInfo,
      'Backend Engineer (2026-07-01)',
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
