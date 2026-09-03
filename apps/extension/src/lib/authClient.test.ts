import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { fakeCookies } from './fakeCookies';
import { fakeSessionStorage } from './fakeSessionStorage';
import { getAuthToken, setAuthToken } from './authToken';
import { adoptSharedSession, signIn, signOut } from './authClient';

let cookies: ReturnType<typeof fakeCookies>;

beforeEach(() => {
  cookies = fakeCookies();
  vi.stubGlobal('chrome', { storage: fakeSessionStorage(), cookies });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signIn', () => {
  it('stores the token from set-auth-token and sends credentials: omit', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'user-1', email: 'jane@example.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-auth-token': 'the-token' },
      }),
    );

    await signIn('jane@example.com', 'correct horse battery staple');

    await expect(getAuthToken()).resolves.toBe('the-token');
    expect(fetch).toHaveBeenCalledWith(`${EXTENSION_BACKEND_ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ email: 'jane@example.com', password: 'correct horse battery staple' }),
    });
  });

  it('rejects with the backend’s own message on a bad password, storing no token', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401 }),
    );

    await expect(signIn('jane@example.com', 'wrong')).rejects.toThrow(/Invalid email or password/);
    await expect(getAuthToken()).resolves.toBeUndefined();
  });

  it('rejects when the response has no set-auth-token header, even at 200', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'user-1', email: 'jane@example.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(signIn('jane@example.com', 'correct horse battery staple')).rejects.toThrow(
      /did not return a session token/,
    );
  });

  it('also writes the token into the shared session cookie, for a dashboard tab to pick up', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'user-1', email: 'jane@example.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-auth-token': 'the-token' },
      }),
    );

    await signIn('jane@example.com', 'correct horse battery staple');

    expect(cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'better-auth.session_token', value: 'the-token' }),
    );
  });
});

describe('signOut', () => {
  it('sends the stored token as a bearer header and clears it locally', async () => {
    await setAuthToken('the-token');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await signOut();

    expect(fetch).toHaveBeenCalledWith(`${EXTENSION_BACKEND_ORIGIN}/api/auth/sign-out`, {
      method: 'POST',
      headers: { authorization: 'Bearer the-token', 'content-type': 'application/json' },
      credentials: 'omit',
      body: '{}',
    });
    await expect(getAuthToken()).resolves.toBeUndefined();
  });

  it('clears the local token even when the request fails', async () => {
    await setAuthToken('the-token');
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    await signOut();

    await expect(getAuthToken()).resolves.toBeUndefined();
  });

  it('does nothing over the network when there was no token to begin with', async () => {
    await signOut();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('also clears the shared session cookie, so a dashboard tab stops looking authenticated', async () => {
    cookies.store.set('better-auth.session_token', {
      name: 'better-auth.session_token',
      value: 'the-token',
    } as chrome.cookies.Cookie);
    await setAuthToken('the-token');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await signOut();

    expect(cookies.store.has('better-auth.session_token')).toBe(false);
  });
});

describe('adoptSharedSession', () => {
  it('adopts the dashboard’s session cookie as this extension’s own bearer token', async () => {
    cookies.store.set('better-auth.session_token', {
      name: 'better-auth.session_token',
      value: 'dashboard-token',
    } as chrome.cookies.Cookie);

    await expect(adoptSharedSession()).resolves.toBe(true);
    await expect(getAuthToken()).resolves.toBe('dashboard-token');
  });

  it('resolves false and stores nothing when there is no shared session to adopt', async () => {
    await expect(adoptSharedSession()).resolves.toBe(false);
    await expect(getAuthToken()).resolves.toBeUndefined();
  });
});
