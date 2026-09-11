/**
 * What an expired or missing session means to a view, and the one fetch protocol every view that
 * blocks on a Profile used to hand-roll for itself.
 *
 * `isUnauthorized` used to be defined identically four times — here, `useApplicationStore.ts`, and
 * the `Profile`/`Analytics`/`NewApplication` views (and, across the seam, twice more in the
 * extension) — because nothing above any of them owned the rule. It now lives at `@djobi/http-client`
 * instead, the module that actually owns `HttpError`'s shape; every former caller of this module's
 * copy imports it from there directly.
 *
 * `useRemoteProfile` closes the second half of the same gap: `Analytics` and `NewApplication` both
 * fetch `getProfile()` on mount and branch on the same four outcomes — still loading, a real
 * Profile, no Profile saved yet, or the backend didn't answer — but named the last one differently
 * (`'unreachable'` vs `'error'`) and reached it by two independently-written effects. A session that
 * expires mid-fetch is not a fifth outcome either view should learn to render: it is `App.tsx`'s
 * business, via `onUnauthorized`, before either ever sees it.
 *
 * `Profile.tsx`'s own load is deliberately not built on this: it never blocks the form on "no
 * Profile yet" — a missing Profile there means "start from `EMPTY_PROFILE`," not an empty state — so
 * forcing it through the same four-outcome shape would cost more than the two views it would save
 * from repeating.
 */
import { isUnauthorized, userMessage } from '@djobi/http-client';
import type { Profile } from '@djobi/shared';
import { useEffect, useState } from 'react';

/**
 * What fetching the candidate's Profile on mount resolved to.
 *
 * `'none'` and `'unreachable'` stay distinct outcomes rather than folding into one "no Profile to
 * show" state: a candidate who hasn't set one up yet and a backend that didn't answer call for
 * different copy, and only the view knows which words to use for its own layout.
 */
export type RemoteProfile =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: Profile }
  | { kind: 'none' }
  | { kind: 'unreachable'; message: string };

/**
 * Fetches `getProfile()` once per mount (and again whenever `getProfile`/`onUnauthorized` change
 * identity — the same re-fetch-on-fresh-client behaviour both `Analytics` and `NewApplication` had
 * separately), and reports a 401 through `onUnauthorized` instead of surfacing it as a state a view
 * could render the wrong way.
 *
 * Resets to `'loading'` at the start of every run, not only the first: a `getProfile` that changes
 * identity means a fresh client (a sign-in replaced the session), and a stale `'ready'` Profile from
 * the old one should not keep showing while the new fetch is in flight.
 */
export function useRemoteProfile(
  getProfile: () => Promise<Profile | null>,
  onUnauthorized: () => void,
): RemoteProfile {
  const [state, setState] = useState<RemoteProfile>({ kind: 'loading' });

  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    getProfile().then(
      (profile) => {
        if (!current) return;
        setState(profile ? { kind: 'ready', profile } : { kind: 'none' });
      },
      (error: unknown) => {
        if (!current) return;
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        setState({ kind: 'unreachable', message: userMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [getProfile, onUnauthorized]);

  return state;
}
