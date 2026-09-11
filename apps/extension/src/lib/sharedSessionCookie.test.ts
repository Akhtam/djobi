import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_DEV_ORIGINS, EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { fakeCookies } from './fakeCookies';
import {
  clearSharedSessionToken,
  getSharedSessionToken,
  setSharedSessionToken,
} from './sharedSessionCookie';

let cookies: ReturnType<typeof fakeCookies>;

beforeEach(() => {
  cookies = fakeCookies();
  vi.stubGlobal('chrome', { cookies });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSharedSessionToken', () => {
  it('returns undefined when the dashboard has no session cookie', async () => {
    await expect(getSharedSessionToken()).resolves.toBeUndefined();
  });

  it('decodes a percent-encoded cookie value back to the raw token', async () => {
    cookies.store.set('better-auth.session_token', {
      value: 'aDkZvftNqggwYI6roSHOBlqvNoDuZAZf.KO7qr%2B8PzovFjm10MuYcDDHDAxa06yXq5SLcy7CAAEw%3D',
    } as chrome.cookies.Cookie);

    await expect(getSharedSessionToken()).resolves.toBe(
      'aDkZvftNqggwYI6roSHOBlqvNoDuZAZf.KO7qr+8PzovFjm10MuYcDDHDAxa06yXq5SLcy7CAAEw=',
    );
  });

  it('reads by name against the backend origin, not just any cookie', async () => {
    await getSharedSessionToken();
    expect(cookies.get).toHaveBeenCalledWith({
      url: EXTENSION_BACKEND_ORIGIN,
      name: 'better-auth.session_token',
    });
  });

  it('also checks the dashboard dev-server origins, not the backend origin alone', async () => {
    // `fakeCookies` keys its store by name only, so it can't tell two origins apart — this asserts
    // on the calls actually made instead, which is what this test needs to prove.
    expect(DASHBOARD_DEV_ORIGINS.length).toBeGreaterThan(0);
    await getSharedSessionToken();
    for (const url of DASHBOARD_DEV_ORIGINS) {
      expect(cookies.get).toHaveBeenCalledWith({ url, name: 'better-auth.session_token' });
    }
  });

  /**
   * The gap this whole fallback exists to close: `vite.config.ts`'s dev-server proxy makes a
   * dashboard sign-in's cookie land on the dashboard's own dev origin, never on
   * `EXTENSION_BACKEND_ORIGIN` — so a lookup that only ever checked the backend origin would find
   * nothing no matter how recently the candidate signed in on the dashboard. A per-origin-aware
   * stub is needed here because `fakeCookies` (used everywhere else in this file) can't represent
   * "present on one origin, absent on another" at all.
   */
  it('finds a token that lives on a dashboard dev origin instead of the backend origin', async () => {
    const [dashboardOrigin] = DASHBOARD_DEV_ORIGINS;
    const get = vi.fn(({ url, name }: chrome.cookies.CookieDetails) =>
      Promise.resolve(
        url === dashboardOrigin && name === 'better-auth.session_token'
          ? ({ value: 'from-the-dashboard-tab' } as chrome.cookies.Cookie)
          : null,
      ),
    );
    vi.stubGlobal('chrome', { cookies: { get } });

    await expect(getSharedSessionToken()).resolves.toBe('from-the-dashboard-tab');
    // Checked the backend origin first — still the right answer once a real backend is deployed —
    // before falling through to the dashboard's own.
    expect(get).toHaveBeenCalledWith({
      url: EXTENSION_BACKEND_ORIGIN,
      name: 'better-auth.session_token',
    });
  });
});

describe('setSharedSessionToken', () => {
  it('writes the token percent-encoded, httpOnly, against the backend origin', async () => {
    await setSharedSessionToken('the-raw-token.with+specials=');

    expect(cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: EXTENSION_BACKEND_ORIGIN,
        name: 'better-auth.session_token',
        value: encodeURIComponent('the-raw-token.with+specials='),
        httpOnly: true,
        path: '/',
      }),
    );
  });

  it('round-trips through getSharedSessionToken', async () => {
    const token = 'round-trip-token.abc+123=';
    await setSharedSessionToken(token);
    await expect(getSharedSessionToken()).resolves.toBe(token);
  });

  it('also writes to the dashboard dev-server origins, so a dashboard tab there adopts it too', async () => {
    await setSharedSessionToken('the-raw-token.with+specials=');

    for (const url of DASHBOARD_DEV_ORIGINS) {
      expect(cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({
          url,
          name: 'better-auth.session_token',
          value: encodeURIComponent('the-raw-token.with+specials='),
        }),
      );
    }
  });
});

describe('clearSharedSessionToken', () => {
  it('removes the cookie by name against the backend origin', async () => {
    await setSharedSessionToken('the-token');
    await clearSharedSessionToken();

    expect(cookies.remove).toHaveBeenCalledWith({
      url: EXTENSION_BACKEND_ORIGIN,
      name: 'better-auth.session_token',
    });
    await expect(getSharedSessionToken()).resolves.toBeUndefined();
  });

  it('also removes it from the dashboard dev-server origins', async () => {
    await setSharedSessionToken('the-token');
    await clearSharedSessionToken();

    for (const url of DASHBOARD_DEV_ORIGINS) {
      expect(cookies.remove).toHaveBeenCalledWith({ url, name: 'better-auth.session_token' });
    }
  });
});

describe('without a chrome.cookies API', () => {
  // A context that predates this module picking up the `cookies` permission (mid-update, before a
  // browser restart) — or a test file whose own `chrome` stub, like several elsewhere in this
  // suite, doesn't include one. All three functions degrade to "no shared session" rather than
  // throwing a raw `ReferenceError`/`TypeError` out of an unrelated caller's load effect.
  beforeEach(() => {
    vi.stubGlobal('chrome', {});
  });

  it('getSharedSessionToken resolves undefined', async () => {
    await expect(getSharedSessionToken()).resolves.toBeUndefined();
  });

  it('setSharedSessionToken and clearSharedSessionToken resolve without throwing', async () => {
    await expect(setSharedSessionToken('a-token')).resolves.toBeUndefined();
    await expect(clearSharedSessionToken()).resolves.toBeUndefined();
  });
});
