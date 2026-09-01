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
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_USER_ID } from '../db/bootstrapUser.js';
import { createTestApp } from '../testApp.js';

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
