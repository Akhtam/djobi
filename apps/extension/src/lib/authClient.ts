/**
 * Sign-in/out against Better Auth's own routes, and the one place in the extension that reads a
 * raw `Response` rather than going through `callBackend.ts`'s `transport.json`.
 *
 * That transport can't serve this: `auth.ts`'s `bearer()` plugin hands the extension its session
 * token via a `set-auth-token` **response header**, not the JSON body (`docs/multi-tenant-auth.md`,
 * Phase D — "Bearer token for the extension, httpOnly cookie for the dashboard"), and
 * `@djobi/http-client`'s `HttpTransport.json` decodes and returns the body only. A raw `fetch` is
 * the only way to reach the header the token actually arrives in.
 *
 * No CORS wiring is needed for this to work from an extension page: `manifest.ts`'s
 * `host_permissions` already grants `EXTENSION_BACKEND_ORIGIN`, and Chrome exempts a request made
 * from an extension context to a granted host from the cross-origin restrictions an ordinary web
 * page would hit — the same reason every other route in `backendClient.ts` needs no CORS allowlist
 * entry on the backend either.
 */
import { SignInRequestSchema, SignInResultSchema, SignOutResultSchema } from '@djobi/shared';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { clearAuthToken, getAuthToken, setAuthToken } from './authToken';

/**
 * Signs in and stores the bearer token `set-auth-token` carries, or throws with the backend's own
 * message on a rejected credential.
 *
 * `credentials: 'omit'` — deliberately not the dashboard's `'include'`. This request carries no
 * cookie and wants none set; the extension's session lives entirely in the `Authorization` header
 * from here on, per the Bearer/cookie split above.
 */
export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch(`${EXTENSION_BACKEND_ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(SignInRequestSchema.parse({ email, password })),
  });

  if (!response.ok) {
    const reason = await response
      .json()
      .then((body: unknown) => (body as { error?: string })?.error)
      .catch(() => undefined);
    throw new Error(reason ?? `Sign-in failed (${response.status}).`);
  }

  // Validated for the same reason every other backend response is: a shape Better Auth stops
  // sending is a compile-time-invisible break this parse turns into a clear failure here instead of
  // a silent `undefined` reaching `setAuthToken`.
  SignInResultSchema.parse(await response.json());

  const token = response.headers.get('set-auth-token');
  if (!token) {
    throw new Error('Sign-in succeeded but the backend did not return a session token.');
  }
  await setAuthToken(token);
}

/**
 * Ends the session, backend-side and locally alike.
 *
 * Sends whatever token is currently stored so the backend can invalidate that session record too —
 * without it, `POST /api/auth/sign-out` would have no session to identify and would only ever be
 * clearing this browser's copy, leaving a token a candidate no longer wants live on the server able
 * to keep authenticating. Local storage is cleared regardless of whether the request lands: a
 * candidate who asked to sign out on a machine that turns out to be offline still expects the
 * extension to stop acting as them.
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
}
