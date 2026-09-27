/**
 * Sign-in/out against Better Auth's routes. Uses raw `fetch` rather than the transport because the
 * bearer token arrives in the `set-auth-token` response *header*, which `transport.json` doesn't
 * expose. No CORS setup needed: the backend origin is in `manifest.ts`'s `host_permissions`.
 */
import { errorBodyFrom, HttpError, isUnauthorized } from '@djobi/http-client';
import { SignInRequestSchema, SignInResultSchema, SignOutResultSchema } from '@djobi/shared';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { clearAuthToken, getAuthToken, setAuthToken } from './authToken';
import {
  clearSharedSessionToken,
  getSharedSessionToken,
  setSharedSessionToken,
} from './sharedSessionCookie';

/**
 * Signs in and stores the `set-auth-token` bearer token, or throws with the backend's message.
 * `credentials: 'omit'`: the extension's session lives only in the `Authorization` header.
 */
export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch(`${EXTENSION_BACKEND_ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(SignInRequestSchema.parse({ email, password })),
  });

  if (!response.ok) {
    // Better Auth answers `{ message, code }`, not this app's `{ error }`.
    const rawBody = await response.text().catch(() => '');
    const reason = rawBody ? errorBodyFrom(rawBody).reason : undefined;
    // An `HttpError` so callers can classify a 401 as they do for every other call.
    throw new HttpError(
      'http',
      '/api/auth/sign-in/email',
      reason ?? `Sign-in failed (${response.status}).`,
      response.status,
    );
  }

  // Validated so a changed Better Auth response fails here, not as `undefined` in `setAuthToken`.
  SignInResultSchema.parse(await response.json());

  const token = response.headers.get('set-auth-token');
  if (!token) {
    // `invalid-response`, not `http`: the call itself succeeded and the backend broke its own
    // contract, which is the same thing a response failing its schema parse means elsewhere.
    throw new HttpError(
      'invalid-response',
      '/api/auth/sign-in/email',
      'Sign-in succeeded but the backend did not return a session token.',
    );
  }
  await setAuthToken(token);
  // Best-effort: also share the session with the dashboard (see `sharedSessionCookie.ts`).
  await setSharedSessionToken(token).catch(() => undefined);
}

/**
 * Ends the session on the backend (sending the current token so it can be invalidated) and locally.
 * Local state is cleared even if the request fails — signing out offline must still work.
 */
export async function signOut(): Promise<void> {
  const token = await getAuthToken();
  if (token) {
    try {
      const response = await fetch(`${EXTENSION_BACKEND_ORIGIN}/api/auth/sign-out`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        credentials: 'omit',
        body: '{}',
      });
      if (response.ok) SignOutResultSchema.parse(await response.json());
    } catch {
      // Unreachable backend, offline, whatever — see the doc comment above for why this is not
      // this function's failure to report. The token is cleared below either way.
    }
  }
  await clearAuthToken();
  // Best-effort, same reasoning as the token clear above: a candidate signing out here shouldn't
  // leave a dashboard tab holding a cookie for the session the request just invalidated.
  await clearSharedSessionToken().catch(() => undefined);
}

/**
 * Adopts a session established elsewhere (usually the dashboard) by copying its session cookie into
 * the bearer token. `true` if there was one; `false` if not or the cookie lookup failed.
 * Optimistic: callers still retry and treat a further 401 as signed out.
 */
export async function adoptSharedSession(): Promise<boolean> {
  try {
    const token = await getSharedSessionToken();
    if (!token) return false;
    await setAuthToken(token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `attempt`, and once more after {@link adoptSharedSession} if it fails with a 401. A second
 * 401 is rethrown as a genuinely absent session.
 */
export async function withSharedSessionRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isUnauthorized(error) || !(await adoptSharedSession())) throw error;
    return attempt();
  }
}
