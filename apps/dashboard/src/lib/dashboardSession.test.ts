import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '@djobi/http-client';
import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { useRemoteProfile } from './dashboardSession';

const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe' };

// `isUnauthorized`'s own truth table is covered at `@djobi/http-client`'s test suite now — the
// module that owns it — rather than re-asserted here against a local re-export.

describe('useRemoteProfile', () => {
  it('reports loading, then ready with the fetched profile', async () => {
    // `getProfile` and `onUnauthorized` are hoisted outside the render callback deliberately: a
    // real caller passes stable, prop-level functions, and an inline arrow recreated on every
    // render would give the effect a new `[getProfile, onUnauthorized]` identity on every one of
    // its own re-renders — an infinite fetch loop, not a test of the hook.
    const getProfile = () => Promise.resolve(profile);
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useRemoteProfile(getProfile, onUnauthorized));
    expect(result.current).toEqual({ kind: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ kind: 'ready', profile }));
  });

  it('reports none for a candidate with no saved profile, not an error', async () => {
    const getProfile = () => Promise.resolve(null);
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useRemoteProfile(getProfile, onUnauthorized));
    await waitFor(() => expect(result.current).toEqual({ kind: 'none' }));
  });

  it('reports unreachable, with the failure message, for a non-401 rejection', async () => {
    const error = new HttpError('http', '/profile', 'GET /profile failed (500)', 500);
    const getProfile = () => Promise.reject(error);
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useRemoteProfile(getProfile, onUnauthorized));
    await waitFor(() =>
      expect(result.current).toEqual({
        kind: 'unreachable',
        message: 'GET /profile failed (500)',
      }),
    );
  });

  it('reports a 401 through onUnauthorized instead of as a state', async () => {
    const onUnauthorized = vi.fn();
    const error = new HttpError('http', '/profile', 'nope', 401);
    const getProfile = () => Promise.reject(error);
    const { result } = renderHook(() => useRemoteProfile(getProfile, onUnauthorized));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    // Never surfaced as its own state — a 401 is App.tsx's business, not a fifth outcome a view
    // could render the wrong way.
    expect(result.current).toEqual({ kind: 'loading' });
  });

  it('resets to loading and refetches when the fetch function changes identity', async () => {
    const first: () => Promise<Profile | null> = () => Promise.resolve(profile);
    let resolveSecond: (value: Profile | null) => void = () => {};
    const secondPromise = new Promise<Profile | null>((resolve) => (resolveSecond = resolve));
    const second = () => secondPromise;
    const onUnauthorized = vi.fn();

    const { result, rerender } = renderHook(
      ({ fetch }: { fetch: () => Promise<Profile | null> }) =>
        useRemoteProfile(fetch, onUnauthorized),
      { initialProps: { fetch: first } },
    );
    await waitFor(() => expect(result.current).toEqual({ kind: 'ready', profile }));

    rerender({ fetch: second });
    // A fresh client — a sign-in replaced the session — should not keep showing the old profile
    // while the new fetch is in flight.
    expect(result.current).toEqual({ kind: 'loading' });

    await act(async () => {
      resolveSecond(null);
      await secondPromise;
    });
    await waitFor(() => expect(result.current).toEqual({ kind: 'none' }));
  });

  it('ignores a resolution that lands after unmount', async () => {
    let resolve: (value: Profile | null) => void = () => {};
    const pending = new Promise<Profile | null>((res) => (resolve = res));
    const getProfile = () => pending;
    const onUnauthorized = vi.fn();
    const { unmount } = renderHook(() => useRemoteProfile(getProfile, onUnauthorized));

    unmount();
    // Would throw an "update on an unmounted component" warning if the effect's cleanup flag were
    // not honoured.
    await act(async () => {
      resolve(profile);
      await pending;
    });
  });
});
