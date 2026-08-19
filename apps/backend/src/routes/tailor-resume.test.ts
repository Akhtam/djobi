import type { JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriorApplication } from '../db/applicationsRepository.js';

const { mockTailorResume, mockListPriorApplicationsByCompany } = vi.hoisted(() => ({
  mockTailorResume: vi.fn(),
  mockListPriorApplicationsByCompany: vi.fn(),
}));

vi.mock('../llm/tailorResume.js', () => ({
  tailorResume: mockTailorResume,
}));

vi.mock('../db/applicationsRepository.js', () => ({
  listPriorApplicationsByCompany: mockListPriorApplicationsByCompany,
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

/** The projection the summary reads — deliberately not a whole `Application`. */
const priorApplication: PriorApplication = {
  roleTitle: 'Backend Engineer',
  createdAt: '2026-07-01T00:00:00.000Z',
};

describe('POST /tailor-resume', () => {
  beforeEach(() => {
    mockTailorResume.mockReset();
    mockListPriorApplicationsByCompany.mockReset();
  });

  it('returns the tailored resume for a valid request', async () => {
    mockListPriorApplicationsByCompany.mockResolvedValue([]);
    mockTailorResume.mockResolvedValue(sampleTailoredResume);

    const res = await app.request('/tailor-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleTailoredResume);
    expect(mockListPriorApplicationsByCompany).toHaveBeenCalledWith('Acme');
    expect(mockTailorResume).toHaveBeenCalledWith(sampleProfile, sampleJobInfo, undefined);
  });

  it('passes a summary of prior applications to the same company', async () => {
    mockListPriorApplicationsByCompany.mockResolvedValue([priorApplication]);
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

  it('lists every prior application, newest first, one per line', async () => {
    mockListPriorApplicationsByCompany.mockResolvedValue([
      priorApplication,
      { roleTitle: 'Platform Engineer', createdAt: '2026-05-02T00:00:00.000Z' },
    ]);
    mockTailorResume.mockResolvedValue(sampleTailoredResume);

    await app.request('/tailor-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, jobInfo: sampleJobInfo }),
    });

    expect(mockTailorResume).toHaveBeenCalledWith(
      sampleProfile,
      sampleJobInfo,
      'Backend Engineer (2026-07-01)\nPlatform Engineer (2026-05-02)',
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
