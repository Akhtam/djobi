import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExtractJob } = vi.hoisted(() => ({ mockExtractJob: vi.fn() }));

vi.mock('../llm/extractJob.js', () => ({
  extractJob: mockExtractJob,
}));

const { app } = await import('../app.js');

const sampleJobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: ['TypeScript', 'Postgres'],
};

describe('POST /extract-job', () => {
  beforeEach(() => {
    mockExtractJob.mockReset();
  });

  it('returns the extracted job info for a valid request', async () => {
    mockExtractJob.mockResolvedValue(sampleJobInfo);

    const res = await app.request('/extract-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageText: 'Senior Software Engineer at Acme...' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleJobInfo);
    expect(mockExtractJob).toHaveBeenCalledWith('Senior Software Engineer at Acme...');
  });

  it('returns 400 when pageText is missing', async () => {
    const res = await app.request('/extract-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mockExtractJob).not.toHaveBeenCalled();
  });

  it('returns 400 when pageText is empty', async () => {
    const res = await app.request('/extract-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageText: '' }),
    });

    expect(res.status).toBe(400);
    expect(mockExtractJob).not.toHaveBeenCalled();
  });
});
