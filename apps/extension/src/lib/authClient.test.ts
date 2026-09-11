import { HttpError } from '@djobi/http-client';
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

  it('reads Better Auth’s own { message, code } body — its real shape, not this app’s { error }', async () => {
    // What `/api/auth/sign-in/email` actually answers with on a bad credential — Better Auth's own
    // route, passed straight through by `app.ts`, never this backend's own `{ error }` convention.
    // Reading only `.error` here left this falling back to the generic "Sign-in failed (401)."
    // message, past whatever Better Auth had actually said.
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }),
        { status: 401 },
      ),
    );

    const rejection = await signIn('jane@example.com', 'wrong').catch((error: unknown) => error);

    expect(rejection).toMatchObject({ message: 'Invalid email or password' });
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

  it('rejects a bad credential as an HttpError carrying the status, like every other backend call', async () => {
    // The fake client in `backendClient.ts` rejects with an `HttpError`, and `pipelineFailure.ts`
    // classifies a 401 by `kind`/`status`. A plain `Error` here would make the fake a shape
    // production never delivers — the seam's two adapters have to agree.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid email or password' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const rejection = await signIn('jane@example.com', 'wrong').catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(HttpError);
    expect(rejection).toMatchObject({
      kind: 'http',
      status: 401,
      message: 'Invalid email or password',
    });
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
