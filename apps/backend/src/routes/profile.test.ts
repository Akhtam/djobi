/**
 * The two Profile routes, driven against in-memory persistence.
 *
 * The assertions are about what is *stored* rather than about which function was called with what:
 * a saved Profile is asserted by reading it back, and a rejected body by the store still holding
 * what it held before. That is the whole reason the seam exists — `expect(mockSaveProfile).not
 * .toHaveBeenCalled()` proves a call didn't happen, which is a weaker claim than the profile being
 * unchanged, and it goes on passing if the route starts writing through some other path.
 */
import type { Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_USER_ID } from '../db/bootstrapUser.js';
import { NoResumeTextError } from '../llm/extractResume.js';
import { createTestApp } from '../testApp.js';

const { mockExtractResume } = vi.hoisted(() => ({ mockExtractResume: vi.fn() }));

vi.mock('../llm/extractResume.js', () => ({
  extractResume: mockExtractResume,
  NoResumeTextError: class NoResumeTextError extends Error {
    constructor(message = 'No extractable text was found in this PDF.') {
      super(message);
    }
  },
}));

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
  skills: ['TypeScript'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('GET /profile', () => {
  it('returns the stored profile', async () => {
    const { app } = createTestApp({ profile: sampleProfile });

    const res = await app.request('/profile');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleProfile);
  });

  it('returns null when no profile has been saved yet', async () => {
    const { app } = createTestApp();

    const res = await app.request('/profile');

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns 401 with no credential', async () => {
    const { app } = createTestApp({ profile: sampleProfile, authenticatedAs: null });

    const res = await app.request('/profile');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required' });
  });

  it("never returns a different user's profile", async () => {
    const { app } = createTestApp({
      profile: sampleProfile,
      authenticatedAs: '00000000-0000-4000-8000-000000000099',
    });

    const res = await app.request('/profile');

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe('POST /profile', () => {
  it('saves a valid profile, returns it, and stores it for the next read', async () => {
    const { app, profileStore } = createTestApp();

    const res = await app.request('/profile', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(sampleProfile),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleProfile);
    expect(await profileStore.get(BOOTSTRAP_USER_ID)).toEqual(sampleProfile);
  });

  it('returns 400 and leaves the stored profile alone when the body fails validation', async () => {
    const { app, profileStore } = createTestApp({ profile: sampleProfile });
    const { fullName: _fullName, ...invalidProfile } = sampleProfile;

    const res = await app.request('/profile', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(invalidProfile),
    });

    expect(res.status).toBe(400);
    expect(await profileStore.get(BOOTSTRAP_USER_ID)).toEqual(sampleProfile);
  });
});

const extractedDraft = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: [],
  projects: [],
  certifications: [],
  awards: [],
};

/** Every multipart request in this suite: a `resume` field, unless the case overrides it. */
function multipartRequest(
  fields: Record<string, File | string> = {
    resume: new File(['%PDF-1.4 fixture'], 'resume.pdf', { type: 'application/pdf' }),
  },
  headers: Record<string, string> = { 'x-djobi-upload': '1' },
): RequestInit {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return { method: 'POST', headers, body: form };
}

describe('POST /profile/extract-resume', () => {
  beforeEach(() => {
    mockExtractResume.mockReset();
  });

  it('returns the extracted draft profile, without saving it', async () => {
    mockExtractResume.mockResolvedValue(extractedDraft);
    const { app, profileStore } = createTestApp();

    const res = await app.request('/profile/extract-resume', multipartRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(extractedDraft);
    expect(mockExtractResume).toHaveBeenCalledWith(expect.any(Buffer), expect.any(AbortSignal));
    expect(await profileStore.get(BOOTSTRAP_USER_ID)).toBeNull();
  });

  it('returns 400 and never calls extraction when no "resume" field is given', async () => {
    const { app } = createTestApp();

    const res = await app.request('/profile/extract-resume', multipartRequest({}));

    expect(res.status).toBe(400);
    expect(mockExtractResume).not.toHaveBeenCalled();
  });

  it('returns 400 and never calls extraction for a non-PDF file', async () => {
    const { app } = createTestApp();

    const res = await app.request(
      '/profile/extract-resume',
      multipartRequest({ resume: new File(['hi'], 'resume.txt', { type: 'text/plain' }) }),
    );

    expect(res.status).toBe(400);
    expect(mockExtractResume).not.toHaveBeenCalled();
  });

  it('returns 400 and never calls extraction for an upload over the 5MB cap', async () => {
    const { app } = createTestApp();
    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'resume.pdf', {
      type: 'application/pdf',
    });

    const res = await app.request(
      '/profile/extract-resume',
      multipartRequest({ resume: oversized }),
    );

    expect(res.status).toBe(400);
    expect(mockExtractResume).not.toHaveBeenCalled();
  });

  it('returns 400 with a clear message when the PDF has no extractable text', async () => {
    mockExtractResume.mockRejectedValue(new NoResumeTextError());
    const { app } = createTestApp();

    const res = await app.request('/profile/extract-resume', multipartRequest());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No extractable text was found in this PDF.' });
  });

  it('returns 401 with no credential', async () => {
    const { app } = createTestApp({ authenticatedAs: null });

    const res = await app.request('/profile/extract-resume', multipartRequest());

    expect(res.status).toBe(401);
    expect(mockExtractResume).not.toHaveBeenCalled();
  });

  it('rejects a multipart upload with no preflight-forcing header, the same CSRF guard JSON routes get', async () => {
    const { app } = createTestApp();

    const res = await app.request('/profile/extract-resume', multipartRequest(undefined, {}));

    expect(res.status).toBe(415);
    expect(mockExtractResume).not.toHaveBeenCalled();
  });
});
