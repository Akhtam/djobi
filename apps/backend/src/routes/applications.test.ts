import type { Application } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListApplications, mockGetApplicationById, mockSaveApplication } = vi.hoisted(() => ({
  mockListApplications: vi.fn(),
  mockGetApplicationById: vi.fn(),
  mockSaveApplication: vi.fn(),
}));

vi.mock('../db/applicationsRepository.js', () => ({
  listApplications: mockListApplications,
  getApplicationById: mockGetApplicationById,
  saveApplication: mockSaveApplication,
}));

const { app } = await import('../app.js');

const sampleApplication: Application = {
  id: 'application-1',
  company: 'Acme',
  roleTitle: 'Senior Software Engineer',
  jobUrl: 'https://acme.com/jobs/123',
  jobInfo: {
    company: 'Acme',
    team: 'Platform',
    roleTitle: 'Senior Software Engineer',
    seniority: 'Senior',
    location: 'Remote',
    requirements: ['5+ years of backend experience'],
    keywords: ['TypeScript', 'Postgres'],
  },
  tailoredResume: {
    summary: 'Backend engineer with a focus on TypeScript.',
    skills: ['TypeScript'],
    workExperience: [],
  },
  answers: [],
  status: 'draft',
  createdAt: '2026-08-07T00:00:00.000Z',
};

describe('GET /applications', () => {
  beforeEach(() => {
    mockListApplications.mockReset();
    mockGetApplicationById.mockReset();
  });

  it('returns the list of stored applications', async () => {
    mockListApplications.mockResolvedValue([sampleApplication]);

    const res = await app.request('/applications');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([sampleApplication]);
  });

  it('returns an empty list when no applications have been saved yet', async () => {
    mockListApplications.mockResolvedValue([]);

    const res = await app.request('/applications');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('GET /applications/:id', () => {
  beforeEach(() => {
    mockListApplications.mockReset();
    mockGetApplicationById.mockReset();
    mockSaveApplication.mockReset();
  });

  it('returns the application with the given id', async () => {
    mockGetApplicationById.mockResolvedValue(sampleApplication);

    const res = await app.request('/applications/application-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleApplication);
    expect(mockGetApplicationById).toHaveBeenCalledWith('application-1');
  });

  it('returns 404 when no application exists with that id', async () => {
    mockGetApplicationById.mockResolvedValue(null);

    const res = await app.request('/applications/does-not-exist');

    expect(res.status).toBe(404);
  });
});

describe('POST /applications', () => {
  const { id: _id, createdAt: _createdAt, ...newApplication } = sampleApplication;

  beforeEach(() => {
    mockListApplications.mockReset();
    mockGetApplicationById.mockReset();
    mockSaveApplication.mockReset();
  });

  it('saves a valid new application and returns it', async () => {
    mockSaveApplication.mockResolvedValue(sampleApplication);

    const res = await app.request('/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newApplication),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleApplication);
    expect(mockSaveApplication).toHaveBeenCalledWith(newApplication);
  });

  it('defaults status to draft when omitted', async () => {
    mockSaveApplication.mockResolvedValue(sampleApplication);
    const { status: _status, ...withoutStatus } = newApplication;

    const res = await app.request('/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withoutStatus),
    });

    expect(res.status).toBe(200);
    expect(mockSaveApplication).toHaveBeenCalledWith({ ...withoutStatus, status: 'draft' });
  });

  it('returns 400 and does not save when the body fails validation', async () => {
    const { company: _company, ...invalidApplication } = newApplication;

    const res = await app.request('/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidApplication),
    });

    expect(res.status).toBe(400);
    expect(mockSaveApplication).not.toHaveBeenCalled();
  });
});
