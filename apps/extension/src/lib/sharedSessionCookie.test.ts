import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
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
