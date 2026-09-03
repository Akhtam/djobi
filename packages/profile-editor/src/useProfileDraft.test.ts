import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
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

  it('a revision captured before an edit reports stale afterward', () => {
    const { result } = renderHook(() => useProfileDraft());
    act(() => result.current.load(EMPTY_PROFILE));
    const revision = result.current.captureRevision();

    expect(result.current.isStale(revision)).toBe(false);
    act(() => result.current.setProfile({ ...EMPTY_PROFILE, fullName: 'Jane Doe' }));
    expect(result.current.isStale(revision)).toBe(true);
  });

  it('load() does not itself advance the revision, so a load after a save is never "stale" of itself', () => {
    const { result } = renderHook(() => useProfileDraft());
    const revision = result.current.captureRevision();
    act(() => result.current.load(EMPTY_PROFILE));
    expect(result.current.isStale(revision)).toBe(false);
  });
});
