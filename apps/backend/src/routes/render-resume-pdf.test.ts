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
      },
      sampleTailoredResume,
    );
  });

  it('reuses a completed render for sequential identical requests', async () => {
    const profile = { ...sampleProfile, fullName: 'Sequential Candidate' };
    const samplePdfBuffer = Buffer.from('sequential pdf');
    mockRenderResumePdf.mockResolvedValue(samplePdfBuffer);

    const first = await renderRequest(profile);
    const second = await renderRequest(profile);

    expect(Buffer.from(await first.arrayBuffer())).toEqual(samplePdfBuffer);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(samplePdfBuffer);
    expect(mockRenderResumePdf).toHaveBeenCalledTimes(1);
  });

  it('reuses an in-flight render for concurrent identical requests', async () => {
    const profile = { ...sampleProfile, fullName: 'Concurrent Candidate' };
    const samplePdfBuffer = Buffer.from('concurrent pdf');
    let resolveRender!: (buffer: Buffer) => void;
    mockRenderResumePdf.mockImplementation(
      () => new Promise<Buffer>((resolve) => (resolveRender = resolve)),
    );

    const firstRequest = renderRequest(profile);
    const secondRequest = renderRequest(profile);
    await vi.waitFor(() => expect(mockRenderResumePdf).toHaveBeenCalledTimes(1));
    resolveRender(samplePdfBuffer);

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(samplePdfBuffer);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(samplePdfBuffer);
    expect(mockRenderResumePdf).toHaveBeenCalledTimes(1);
  });

  it('renders again when the validated input changes', async () => {
    const profile = { ...sampleProfile, fullName: 'Changed Input Candidate' };
    const changedResume = { ...sampleTailoredResume, skills: ['TypeScript', 'React'] };
    mockRenderResumePdf
      .mockResolvedValueOnce(Buffer.from('first pdf'))
      .mockResolvedValueOnce(Buffer.from('changed pdf'));

    await renderRequest(profile);
    await renderRequest(profile, changedResume);

    expect(mockRenderResumePdf).toHaveBeenCalledTimes(2);
    const renderProfile = {
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      links: profile.links,
      education: profile.education,
    };
    expect(mockRenderResumePdf).toHaveBeenNthCalledWith(1, renderProfile, sampleTailoredResume);
    expect(mockRenderResumePdf).toHaveBeenNthCalledWith(2, renderProfile, changedResume);
  });

  it('retries an identical render after the previous render rejects', async () => {
    const profile = { ...sampleProfile, fullName: 'Retry Candidate' };
    const samplePdfBuffer = Buffer.from('retry pdf');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRenderResumePdf
      .mockRejectedValueOnce(new Error('render failed'))
      .mockResolvedValueOnce(samplePdfBuffer);

    const failed = await renderRequest(profile);
    const retried = await renderRequest(profile);

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(Buffer.from(await retried.arrayBuffer())).toEqual(samplePdfBuffer);
    expect(mockRenderResumePdf).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
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
