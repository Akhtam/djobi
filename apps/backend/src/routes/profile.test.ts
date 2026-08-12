import type { Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetProfile, mockSaveProfile } = vi.hoisted(() => ({
  mockGetProfile: vi.fn(),
  mockSaveProfile: vi.fn(),
}));

vi.mock('../db/profileRepository.js', () => ({
  getProfile: mockGetProfile,
  saveProfile: mockSaveProfile,
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

describe('GET /profile', () => {
  beforeEach(() => {
    mockGetProfile.mockReset();
    mockSaveProfile.mockReset();
  });

  it('returns the stored profile', async () => {
    mockGetProfile.mockResolvedValue(sampleProfile);

    const res = await app.request('/profile');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleProfile);
  });

  it('returns null when no profile has been saved yet', async () => {
    mockGetProfile.mockResolvedValue(null);

    const res = await app.request('/profile');

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe('POST /profile', () => {
  beforeEach(() => {
    mockGetProfile.mockReset();
    mockSaveProfile.mockReset();
  });

  it('saves a valid profile and returns it', async () => {
    mockSaveProfile.mockResolvedValue(sampleProfile);

    const res = await app.request('/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleProfile),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleProfile);
    expect(mockSaveProfile).toHaveBeenCalledWith(sampleProfile);
  });

  it('returns 400 and does not save when the body fails validation', async () => {
    const { fullName: _fullName, ...invalidProfile } = sampleProfile;

    const res = await app.request('/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidProfile),
    });

    expect(res.status).toBe(400);
    expect(mockSaveProfile).not.toHaveBeenCalled();
  });
});
