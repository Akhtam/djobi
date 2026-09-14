import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '@djobi/http-client';
import { EMPTY_PROFILE, type ExtractedProfile, type Profile } from '@djobi/shared';
import {
  profileOutcomeMessage,
  useProfileWorkflow,
  type ProfilePagePort,
} from './useProfileWorkflow.js';

const stored: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe' };

function unauthorized() {
  return new HttpError('http', '/profile', 'Authentication required', 401);
}

function fakePort(overrides: Partial<ProfilePagePort> = {}): ProfilePagePort {
  return {
    loadProfile: vi.fn(async () => stored),
    saveProfile: vi.fn(async (profile: Profile) => profile),
    extractResume: vi.fn(async (): Promise<ExtractedProfile> => ({
      fullName: 'Parsed Name',
      email: null,
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
    })),
    ...overrides,
  };
}

function renderWorkflow(port: ProfilePagePort, onUnauthorized = vi.fn()) {
  const view = renderHook(({ p }) => useProfileWorkflow(p, onUnauthorized), {
    initialProps: { p: port },
  });
  return { ...view, onUnauthorized };
}

const pdf = () => new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' });

describe('useProfileWorkflow load', () => {
  it('loads the stored profile', async () => {
    const { result } = renderWorkflow(fakePort());
    await waitFor(() => expect(result.current.draft.profile?.fullName).toBe('Jane Doe'));
    expect(result.current.loadError).toBeNull();
  });

  it('falls back to an empty profile when none is stored', async () => {
    const { result } = renderWorkflow(fakePort({ loadProfile: async () => null }));
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    expect(result.current.draft.profile?.fullName).toBe(EMPTY_PROFILE.fullName);
  });

  it('falls back to an empty profile and reports the error when loading fails', async () => {
    const failure = new Error('backend down');
    const { result } = renderWorkflow(fakePort({ loadProfile: () => Promise.reject(failure) }));
    await waitFor(() => expect(result.current.loadError).toBe(failure));
    expect(result.current.draft.profile).toEqual(EMPTY_PROFILE);
  });

  it('reports a 401 to onUnauthorized without loading a draft', async () => {
    const { result, onUnauthorized } = renderWorkflow(
      fakePort({ loadProfile: () => Promise.reject(unauthorized()) }),
    );
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
    expect(result.current.draft.profile).toBeNull();
    expect(result.current.loadError).toBeNull();
  });

  it('ignores a load that resolves after the port was replaced', async () => {
    let resolveFirst: (profile: Profile) => void = () => {};
    const first = fakePort({
      loadProfile: () => new Promise((resolve) => (resolveFirst = resolve)),
    });
    const second = fakePort({ loadProfile: async () => ({ ...stored, fullName: 'Second' }) });
    const { result, rerender } = renderWorkflow(first);
    rerender({ p: second });
    await waitFor(() => expect(result.current.draft.profile?.fullName).toBe('Second'));
    await act(async () => resolveFirst({ ...stored, fullName: 'First' }));
    expect(result.current.draft.profile?.fullName).toBe('Second');
  });

  it('does not reload when only onUnauthorized changes identity', async () => {
    const port = fakePort();
    const view = renderHook(({ cb }) => useProfileWorkflow(port, cb), {
      initialProps: { cb: vi.fn() },
    });
    await waitFor(() => expect(view.result.current.draft.profile).not.toBeNull());
    view.rerender({ cb: vi.fn() });
    expect(port.loadProfile).toHaveBeenCalledOnce();
  });

  it('reload() loads again', async () => {
    const port = fakePort();
    const { result } = renderWorkflow(port);
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    act(() => result.current.reload());
    await waitFor(() => expect(port.loadProfile).toHaveBeenCalledTimes(2));
  });
});

describe('useProfileWorkflow save', () => {
  it('reports a successful save and clears a load error', async () => {
    const { result } = renderWorkflow(
      fakePort({ loadProfile: () => Promise.reject(new Error('backend down')) }),
    );
    await waitFor(() => expect(result.current.loadError).not.toBeNull());
    await act(() => result.current.save());
    expect(result.current.saveResult).toEqual({ kind: 'saved' });
    expect(result.current.loadError).toBeNull();
  });

  it('keeps the draft and reports a failed save', async () => {
    const failure = new Error('nope');
    const { result } = renderWorkflow(fakePort({ saveProfile: () => Promise.reject(failure) }));
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    act(() => result.current.setProfile({ ...stored, fullName: 'Edited' }));
    await act(() => result.current.save());
    expect(result.current.saveResult).toEqual({ kind: 'save-failed', error: failure });
    expect(result.current.draft.profile?.fullName).toBe('Edited');
    expect(result.current.draft.dirty).toBe(true);
  });

  it('reports a 401 on save to onUnauthorized instead of as a failure', async () => {
    const { result, onUnauthorized } = renderWorkflow(
      fakePort({ saveProfile: () => Promise.reject(unauthorized()) }),
    );
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    await act(() => result.current.save());
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(result.current.saveResult).toBeNull();
  });

  it('retires "saved" on the next edit but keeps a failure visible', async () => {
    const port = fakePort();
    const { result } = renderWorkflow(port);
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    await act(() => result.current.save());
    act(() => result.current.setProfile({ ...stored, fullName: 'Edited' }));
    expect(result.current.saveResult).toBeNull();

    vi.mocked(port.saveProfile).mockRejectedValueOnce(new Error('nope'));
    await act(() => result.current.save());
    act(() => result.current.setProfile({ ...stored, fullName: 'Edited again' }));
    expect(result.current.saveResult?.kind).toBe('save-failed');
  });

  it('drops a save response superseded by an edit made while it was in flight', async () => {
    let resolveSave: (profile: Profile) => void = () => {};
    const { result } = renderWorkflow(
      fakePort({ saveProfile: () => new Promise((resolve) => (resolveSave = resolve)) }),
    );
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save();
    });
    act(() => result.current.setProfile({ ...stored, fullName: 'Typed while saving' }));
    await act(async () => {
      resolveSave(stored);
      await saving;
    });
    expect(result.current.saveResult).toBeNull();
    expect(result.current.draft.profile?.fullName).toBe('Typed while saving');
  });
});

describe('useProfileWorkflow resume upload', () => {
  it('applies the extraction and reports it parsed', async () => {
    const { result } = renderWorkflow(fakePort());
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    await act(() => result.current.uploadResume(pdf()));
    expect(result.current.draft.profile?.fullName).toBe('Parsed Name');
    expect(result.current.uploadResult).toEqual({ kind: 'parsed' });
  });

  it('retires a "saved" result, since the parse is an unsaved edit', async () => {
    const { result } = renderWorkflow(fakePort());
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    await act(() => result.current.save());
    await act(() => result.current.uploadResume(pdf()));
    expect(result.current.saveResult).toBeNull();
  });

  it('reports a failed parse', async () => {
    const failure = new Error('bad pdf');
    const { result } = renderWorkflow(fakePort({ extractResume: () => Promise.reject(failure) }));
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    await act(() => result.current.uploadResume(pdf()));
    expect(result.current.uploadResult).toEqual({ kind: 'parse-failed', error: failure });
  });

  it('reports a 401 on upload to onUnauthorized', async () => {
    const { result, onUnauthorized } = renderWorkflow(
      fakePort({ extractResume: () => Promise.reject(unauthorized()) }),
    );
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    await act(() => result.current.uploadResume(pdf()));
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(result.current.uploadResult).toBeNull();
  });
});

describe('useProfileWorkflow skills', () => {
  it('addNewSkill() adds the typed skill and clears the input', async () => {
    const { result } = renderWorkflow(fakePort());
    await waitFor(() => expect(result.current.draft.profile).not.toBeNull());
    act(() => result.current.setNewSkill('TypeScript'));
    act(() => result.current.addNewSkill());
    expect(result.current.draft.profile?.skills).toContain('TypeScript');
    expect(result.current.newSkill).toBe('');
  });
});

describe('profileOutcomeMessage', () => {
  it('words each result', () => {
    const error = new Error('boom');
    expect(profileOutcomeMessage({ kind: 'saved' })).toBe('Profile saved.');
    expect(profileOutcomeMessage({ kind: 'parsed' })).toBe(
      'Resume parsed. Review the pre-filled fields below, then save.',
    );
    expect(profileOutcomeMessage({ kind: 'save-failed', error })).toBeTypeOf('string');
    expect(profileOutcomeMessage({ kind: 'parse-failed', error })).toMatch(
      /^Couldn't parse this resume: /,
    );
  });
});
