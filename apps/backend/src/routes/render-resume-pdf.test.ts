import type { Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRenderResumePdf } = vi.hoisted(() => ({ mockRenderResumePdf: vi.fn() }));

vi.mock('../pdf/renderResume.js', () => ({
  renderResumePdf: mockRenderResumePdf,
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

const sampleTailoredResume: TailoredResume = {
  skills: ['TypeScript'],
  workExperience: [],
};

describe('POST /render-resume-pdf', () => {
  beforeEach(() => {
    mockRenderResumePdf.mockReset();
  });

  it('returns the rendered PDF bytes for a valid request', async () => {
    const samplePdfBuffer = Buffer.from('%PDF-1.4 fake pdf bytes');
    mockRenderResumePdf.mockResolvedValue(samplePdfBuffer);

    const res = await app.request('/render-resume-pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, tailoredResume: sampleTailoredResume }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(samplePdfBuffer);
    expect(mockRenderResumePdf).toHaveBeenCalledWith(sampleProfile, sampleTailoredResume);
  });

  it('returns 400 and does not render when the body fails validation', async () => {
    const res = await app.request('/render-resume-pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile }),
    });

    expect(res.status).toBe(400);
    expect(mockRenderResumePdf).not.toHaveBeenCalled();
  });
});
