import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_PROFILE, type ExtractedProfile, type Profile } from '@djobi/shared';
import { useProfileDraft } from './useProfileDraft.js';

describe('useProfileDraft', () => {
  it('starts empty and undirtied', () => {
    const { result } = renderHook(() => useProfileDraft());
    expect(result.current.profile).toBeNull();
    expect(result.current.dirty).toBe(false);
  });

  it('load() replaces the draft without marking it dirty — for a fresh load or a saved result', () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));
    expect(result.current.profile).toBe(EMPTY_PROFILE);
    expect(result.current.dirty).toBe(false);
  });

  it('setProfile() marks the draft dirty', () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));
    const edited: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe' };
    act(() => result.current.setProfile(edited));
    expect(result.current.profile).toBe(edited);
    expect(result.current.dirty).toBe(true);
  });
});

/**
 * The save protocol both editors used to hand-roll identically — capture a revision, normalize,
 * persist, discard a superseded response, load what came back. It lives here so the ordering is
 * the module's to get right rather than each caller's, and so the staleness invariant is asserted
 * once instead of once per form.
 */
describe('useProfileDraft save', () => {
  /** A draft whose one story has no id — enough to prove normalization ran before persisting. */
  const withBlankStoryId: Profile = {
    ...EMPTY_PROFILE,
    fullName: 'Jane Doe',
    stories: [
      {
        id: '',
        title: 'Shipped the thing',
        tags: [],
        situation: '',
        task: '',
        action: '',
        result: '',
      },
    ],
  };

  it('normalizes the draft before persisting it, and loads what came back', async () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(withBlankStoryId));
    // What a backend actually returns: the normalized record, story id and all. A blank id here
    // would fail `parseProfile`'s validation and come back as `EMPTY_PROFILE`.
    const persisted: Profile = {
      ...withBlankStoryId,
      fullName: 'Jane Doe (saved)',
      stories: [{ ...withBlankStoryId.stories[0]!, id: 'story-1' }],
    };
    const persist = vi.fn(() => Promise.resolve(persisted));

    let outcome;
    await act(async () => {
      outcome = await result.current.save(persist);
    });

    expect(outcome).toEqual({ kind: 'saved' });
    // The caller never generated the id — `save` normalized before handing the draft over.
    expect(persist.mock.calls[0]?.[0].stories[0]?.id).toMatch(/\S/);
    expect(result.current.profile?.fullName).toBe('Jane Doe (saved)');
    expect(result.current.dirty).toBe(false);
  });

  it('discards a response superseded by an edit made while the save was in flight', async () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));

    let release: (profile: Profile) => void = () => {};
    const persist = vi.fn(() => new Promise<Profile>((resolve) => (release = resolve)));

    let settled: unknown;
    await act(async () => {
      const pending = result.current.save(persist).then((value) => (settled = value));
      // The candidate keeps typing while the request is out.
      result.current.setProfile({ ...EMPTY_PROFILE, fullName: 'Newer edit' });
      release({ ...EMPTY_PROFILE, fullName: 'Older response' });
      await pending;
    });

    expect(settled).toEqual({ kind: 'stale' });
    expect(result.current.profile?.fullName).toBe('Newer edit');
    expect(result.current.dirty).toBe(true);
  });

  it('reports a rejected save without touching the draft, so the edit survives to be retried', async () => {
    const { result } = renderHook(() => useProfileDraft());
    const edited: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe' };
    act(() => result.current.load(edited));
    const error = new Error('backend unreachable');

    let outcome;
    await act(async () => {
      outcome = await result.current.save(() => Promise.reject(error));
    });

    // The error is handed back rather than classified — a 401 means different things to each app.
    expect(outcome).toEqual({ kind: 'error', error });
    expect(result.current.profile).toEqual(edited);
  });

  it('reports saving for exactly as long as the persist call is in flight', async () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));
    expect(result.current.saving).toBe(false);

    let release: (profile: Profile) => void = () => {};
    const pending = new Promise<Profile>((resolve) => (release = resolve));
    let saved: Promise<unknown>;
    act(() => {
      saved = result.current.save(() => pending);
    });
    await waitFor(() => expect(result.current.saving).toBe(true));

    await act(async () => {
      release(EMPTY_PROFILE);
      await saved;
    });
    expect(result.current.saving).toBe(false);
  });

  it('stops reporting saving even when the persist call rejects', async () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));

    await act(async () => {
      await result.current.save(() => Promise.reject(new Error('nope')));
    });

    expect(result.current.saving).toBe(false);
  });
});

describe('useProfileDraft.applyResume', () => {
  const extraction: ExtractedProfile = {
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: null,
    location: null,
    links: { linkedin: null, portfolio: null, github: null },
    summary: null,
    workExperience: [],
    education: [],
    skills: ['TypeScript'],
    projects: [],
    certifications: [],
    awards: [],
  };

  it('applies what the extraction found and marks the draft dirty', async () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));

    let outcome;
    await act(async () => {
      outcome = await result.current.applyResume(new File([], 'cv.pdf'), () =>
        Promise.resolve(extraction),
      );
    });

    expect(outcome).toEqual({ kind: 'parsed' });
    expect(result.current.profile?.fullName).toBe('Jane Doe');
    expect(result.current.profile?.skills).toEqual(['TypeScript']);
    // Nothing is persisted by this — "You have unsaved changes" is what says so.
    expect(result.current.dirty).toBe(true);
  });

  it('applies onto edits made while the resume was parsing, not the snapshot it started from', async () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));

    let release: (extracted: ExtractedProfile) => void = () => {};
    const pending = new Promise<ExtractedProfile>((resolve) => (release = resolve));
    let applied: Promise<unknown>;
    act(() => {
      applied = result.current.applyResume(new File([], 'cv.pdf'), () => pending);
    });

    // A parse takes seconds and the form stays editable throughout.
    act(() => result.current.setProfile({ ...EMPTY_PROFILE, summary: 'Typed while waiting' }));
    await act(async () => {
      release(extraction);
      await applied;
    });

    expect(result.current.profile?.summary).toBe('Typed while waiting');
    expect(result.current.profile?.fullName).toBe('Jane Doe');
  });

  it('hands back a rejection unclassified and leaves the draft alone', async () => {
    const { result } = renderHook(() => useProfileDraft());
    const loaded: Profile = { ...EMPTY_PROFILE, fullName: 'Already here' };
    act(() => result.current.load(loaded));
    const error = new Error('not a resume');

    let outcome;
    await act(async () => {
      outcome = await result.current.applyResume(new File([], 'cv.pdf'), () =>
        Promise.reject(error),
      );
    });

    expect(outcome).toEqual({ kind: 'error', error });
    expect(result.current.profile).toEqual(loaded);
    expect(result.current.dirty).toBe(false);
  });

  it('does nothing before the first load', async () => {
    const { result } = renderHook(() => useProfileDraft());
    const extract = vi.fn();

    let outcome;
    await act(async () => {
      outcome = await result.current.applyResume(new File([], 'cv.pdf'), extract);
    });

    expect(outcome).toEqual({ kind: 'stale' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('reports extracting for exactly as long as the parse is in flight, rejection included', async () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));
    expect(result.current.extracting).toBe(false);

    let release: (extracted: ExtractedProfile) => void = () => {};
    const pending = new Promise<ExtractedProfile>((resolve) => (release = resolve));
    let applied: Promise<unknown>;
    act(() => {
      applied = result.current.applyResume(new File([], 'cv.pdf'), () => pending);
    });
    await waitFor(() => expect(result.current.extracting).toBe(true));

    await act(async () => {
      release(extraction);
      await applied;
    });
    expect(result.current.extracting).toBe(false);

    await act(async () => {
      await result.current.applyResume(new File([], 'cv.pdf'), () => Promise.reject(new Error()));
    });
    expect(result.current.extracting).toBe(false);
  });
});
