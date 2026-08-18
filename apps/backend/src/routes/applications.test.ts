import type { Application, ApplicationSnapshot } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListApplications,
  mockListApplicationsByJobUrl,
  mockGetApplicationById,
  mockSaveApplication,
  mockUpdateApplication,
  mockUpdateApplicationStage,
  mockAddApplicationNote,
} = vi.hoisted(() => ({
  mockListApplications: vi.fn(),
  mockListApplicationsByJobUrl: vi.fn(),
  mockGetApplicationById: vi.fn(),
  mockSaveApplication: vi.fn(),
  mockUpdateApplication: vi.fn(),
  mockUpdateApplicationStage: vi.fn(),
  mockAddApplicationNote: vi.fn(),
}));

vi.mock('../db/applicationsRepository.js', () => ({
  listApplications: mockListApplications,
  listApplicationsByJobUrl: mockListApplicationsByJobUrl,
  getApplicationById: mockGetApplicationById,
  saveApplication: mockSaveApplication,
  updateApplication: mockUpdateApplication,
  updateApplicationStage: mockUpdateApplicationStage,
  addApplicationNote: mockAddApplicationNote,
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
    skills: ['TypeScript'],
    workExperience: [],
  },
  answers: [],
  stage: 'applied',
  notes: [],
  createdAt: '2026-08-07T00:00:00.000Z',
};

describe('GET /applications', () => {
  beforeEach(() => {
    mockListApplications.mockReset();
    mockListApplicationsByJobUrl.mockReset();
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

  it('narrows to one posting when asked for a job URL — what the duplicate guard on Analyze reads', async () => {
    mockListApplicationsByJobUrl.mockResolvedValue([sampleApplication]);

    const res = await app.request(
      `/applications?jobUrl=${encodeURIComponent('https://acme.com/jobs/123')}`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([sampleApplication]);
    // Matched exactly: the query string can be what tells two postings on one board apart.
    expect(mockListApplicationsByJobUrl).toHaveBeenCalledWith('https://acme.com/jobs/123');
    expect(mockListApplications).not.toHaveBeenCalled();
  });

  it('reports no match for a URL never applied to, rather than falling back to the full list', async () => {
    mockListApplicationsByJobUrl.mockResolvedValue([]);

    const res = await app.request('/applications?jobUrl=https%3A%2F%2Facme.com%2Fjobs%2F999');

    expect(await res.json()).toEqual([]);
    expect(mockListApplications).not.toHaveBeenCalled();
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

  it('defaults stage and notes when the extension omits them', async () => {
    // The Fill Step posts neither field; requiring either would 400 every fill.
    mockSaveApplication.mockResolvedValue(sampleApplication);
    const { stage: _stage, notes: _notes, ...withoutTracking } = newApplication;

    const res = await app.request('/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withoutTracking),
    });

    expect(res.status).toBe(200);
    expect(mockSaveApplication).toHaveBeenCalledWith({
      ...withoutTracking,
      stage: 'applied',
      notes: [],
    });
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

describe('PATCH /applications/:id', () => {
  const {
    id: _id,
    createdAt: _createdAt,
    stage: _stage,
    notes: _notes,
    ...snapshot
  } = sampleApplication;

  beforeEach(() => {
    mockUpdateApplication.mockReset();
  });

  it('updates a valid application snapshot and preserves tracking fields', async () => {
    mockUpdateApplication.mockResolvedValue(sampleApplication);

    const res = await app.request('/applications/application-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot satisfies ApplicationSnapshot),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleApplication);
    expect(mockUpdateApplication).toHaveBeenCalledWith('application-1', snapshot);
  });

  it('returns 404 when the application no longer exists', async () => {
    mockUpdateApplication.mockResolvedValue(null);

    const res = await app.request('/applications/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 and does not update when tracking fields are included', async () => {
    const res = await app.request('/applications/application-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...snapshot, stage: 'rejected' }),
    });

    expect(res.status).toBe(400);
    expect(mockUpdateApplication).not.toHaveBeenCalled();
  });
});

describe('PATCH /applications/:id/stage', () => {
  beforeEach(() => {
    mockUpdateApplicationStage.mockReset();
    mockUpdateApplication.mockReset();
  });

  it('moves an application to a new stage', async () => {
    const moved = { ...sampleApplication, stage: 'interviewing' as const };
    mockUpdateApplicationStage.mockResolvedValue(moved);

    const res = await app.request('/applications/application-1/stage', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'interviewing' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(moved);
    expect(mockUpdateApplicationStage).toHaveBeenCalledWith('application-1', 'interviewing');
  });

  it('rejects a stage outside the enum rather than writing it', async () => {
    const res = await app.request('/applications/application-1/stage', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'ghosted' }),
    });

    expect(res.status).toBe(400);
    expect(mockUpdateApplicationStage).not.toHaveBeenCalled();
  });

  it('404s for an application that does not exist', async () => {
    mockUpdateApplicationStage.mockResolvedValue(null);

    const res = await app.request('/applications/nope/stage', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'applied' }),
    });

    expect(res.status).toBe(404);
  });

  it('does not reach the snapshot route, whose body would reject a bare stage', async () => {
    mockUpdateApplicationStage.mockResolvedValue(sampleApplication);

    await app.request('/applications/application-1/stage', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'applied' }),
    });

    expect(mockUpdateApplication).not.toHaveBeenCalled();
  });
});

describe('POST /applications/:id/notes', () => {
  beforeEach(() => {
    mockAddApplicationNote.mockReset();
  });

  it('appends a note', async () => {
    const withNote = {
      ...sampleApplication,
      notes: [
        {
          id: 'note-1',
          category: 'technical' as const,
          text: 'Asked about idempotency keys.',
          createdAt: '2026-03-18T14:14:00.000Z',
        },
      ],
    };
    mockAddApplicationNote.mockResolvedValue(withNote);

    const res = await app.request('/applications/application-1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'technical', text: 'Asked about idempotency keys.' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(withNote);
    expect(mockAddApplicationNote).toHaveBeenCalledWith('application-1', {
      category: 'technical',
      text: 'Asked about idempotency keys.',
    });
  });

  it('ignores a client-supplied id and createdAt — history the sender chose is not history', async () => {
    mockAddApplicationNote.mockResolvedValue(sampleApplication);

    await app.request('/applications/application-1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'general',
        text: 'Recruiter call.',
        id: 'chosen-by-the-client',
        createdAt: '1999-01-01T00:00:00.000Z',
      }),
    });

    expect(mockAddApplicationNote).toHaveBeenCalledWith('application-1', {
      category: 'general',
      text: 'Recruiter call.',
    });
  });

  it('rejects an unknown category', async () => {
    const res = await app.request('/applications/application-1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'vibes', text: 'Hmm.' }),
    });

    expect(res.status).toBe(400);
    expect(mockAddApplicationNote).not.toHaveBeenCalled();
  });

  it('404s for an application that does not exist', async () => {
    mockAddApplicationNote.mockResolvedValue(null);

    const res = await app.request('/applications/nope/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'general', text: 'Anything.' }),
    });

    expect(res.status).toBe(404);
  });
});
