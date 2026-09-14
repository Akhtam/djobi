/**
 * The header's account control: an avatar-initial trigger — no "Account" label — that opens a small
 * menu with "Profile" (routes to `#/profile`) and "Sign out". Replaces what used to be a bare Sign
 * out button once there were two account-level actions to reach, not one.
 *
 * The initial comes from the Profile's name (falling back to its email) fetched once on mount —
 * there is no separate "current session user" endpoint to read it from, and the Profile is the
 * closest thing to one. A silent failure here (401 included) is deliberately not surfaced: the
 * store's own load already 401s at effectively the same moment and drives the real redirect to
 * `#/login` (`App.tsx`'s `unauthorized` effect) — this is decoration, not the source of truth for
 * whether the session is still good.
 *
 * Hand-rolled rather than `<details>`/`<summary>`: a `<details>` menu has no "close on outside
 * click" for free, and the workaround is the same document listener this uses anyway — so there is
 * nothing to save by starting from `<details>`.
 */
import { useEffect, useRef, useState } from 'react';
import type { DashboardClient } from '../lib/dashboardClient';

/** The avatar's letter: the Profile's name, falling back to its email, first character, upper-cased. */
function initialOf(source: string | null | undefined): string | null {
  const trimmed = source?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : null;
}

export function AccountMenu({
  client,
  onSignOut,
}: {
  client: DashboardClient;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    client.getProfile().then(
      (profile) => {
        if (current) setInitial(initialOf(profile?.fullName) ?? initialOf(profile?.email));
      },
      () => {
        // See file header: a failed fetch here has nothing useful to show and nowhere to report to.
      },
    );
    return () => {
      current = false;
    };
  }, [client]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        className="account-menu__trigger"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="account-menu__avatar" aria-hidden="true">
          {initial ?? ''}
        </span>
        {/* The standard dropdown caret — `aria-hidden` since the button's own `aria-label`/
            `aria-expanded` already say what this is and whether it's open. */}
        <svg
          data-open={open}
          width="12"
          height="12"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 3.5L5 6.5L8 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div className="account-menu__panel" role="menu">
          <a
            className="account-menu__item"
            role="menuitem"
            href="#/profile"
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.75" />
              <path
                d="M4 20c0-3.9 3.58-7 8-7s8 3.1 8 7"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
            Profile
          </a>
          <button
            type="button"
            className="account-menu__item account-menu__item--danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 16l4-4-4-4M20 12H9"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
