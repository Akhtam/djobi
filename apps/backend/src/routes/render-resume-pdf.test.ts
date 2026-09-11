import type { Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRenderResumePdf } = vi.hoisted(() => ({ mockRenderResumePdf: vi.fn() }));

vi.mock('../pdf/renderResume.js', () => ({
  renderResumePdf: mockRenderResumePdf,
}));

const { createTestApp } = await import('../testApp.js');

// These routes touch no store; the in-memory ones exist only so the app can be built.
const { app } = createTestApp();

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  skills: ['TypeScript'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

const sampleTailoredResume: TailoredResume = {
  skills: ['TypeScript'],
  workExperience: [],
};

function renderRequest(profile: Profile, tailoredResume: TailoredResume = sampleTailoredResume) {
  return app.request('/render-resume-pdf', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile, tailoredResume }),
  });
}

describe('POST /render-resume-pdf', () => {
  beforeEach(() => {
    mockRenderResumePdf.mockReset();
  });

  it('returns the rendered PDF bytes for a valid request', async () => {
    const samplePdfBuffer = Buffer.from('%PDF-1.4 fake pdf bytes');
    mockRenderResumePdf.mockResolvedValue(samplePdfBuffer);

    const res = await renderRequest(sampleProfile);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="jane_doe_resume.pdf"');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(samplePdfBuffer);
    expect(mockRenderResumePdf).toHaveBeenCalledWith(
      {
        fullName: sampleProfile.fullName,
        email: sampleProfile.email,
        phone: sampleProfile.phone,
        location: sampleProfile.location,
        links: sampleProfile.links,
        education: sampleProfile.education,
        resumePageSize: sampleProfile.resumePageSize,
        showRolePrefix: sampleProfile.showRolePrefix,
      },
      sampleTailoredResume,
    );
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
