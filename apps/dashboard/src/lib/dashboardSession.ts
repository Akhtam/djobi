/**
 * `useRemoteProfile`: the one fetch-the-Profile-on-mount protocol for views that block on it
 * (`Analytics`, `NewApplication`). A 401 goes to `onUnauthorized` (`App` redirects) rather than
 * becoming a view state. `Profile.tsx` doesn't use it: a missing Profile there just means start
 * from `EMPTY_PROFILE`.
 */
import { isUnauthorized, userMessage } from '@djobi/http-client';
import type { Profile } from '@djobi/shared';
import { useEffect, useState } from 'react';

/**
 * What the Profile fetch resolved to. `'none'` (not set up) and `'unreachable'` stay distinct: they
 * need different copy.
 */
export type RemoteProfile =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: Profile }
  | { kind: 'none' }
  | { kind: 'unreachable'; message: string };

/**
 * Fetches `getProfile()` on mount and whenever `getProfile`/`onUnauthorized` change (a new
 * session), resetting to `'loading'` each time so a stale Profile never shows. A 401 goes to
 * `onUnauthorized`.
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
