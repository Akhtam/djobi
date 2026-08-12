import type { Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchResumePdf } from './fetchResumePdf';

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
};

const tailoredResume: TailoredResume = {
  skills: [],
  workExperience: [],
};

describe('fetchResumePdf', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts profile + tailoredResume to /render-resume-pdf and resolves with the PDF bytes', async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70]);
    vi.mocked(fetch).mockResolvedValue(new Response(pdfBytes.buffer, { status: 200 }));

    const result = await fetchResumePdf(profile, tailoredResume);

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5391/render-resume-pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile, tailoredResume }),
    });
    expect(new Uint8Array(result)).toEqual(pdfBytes);
  });

  it('rejects when the response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));

    await expect(fetchResumePdf(profile, tailoredResume)).rejects.toThrow();
  });
});
