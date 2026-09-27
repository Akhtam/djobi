/**
 * Shares one Better Auth session between the extension and the dashboard via the session cookie,
 * read and written with `chrome.cookies` (which can touch `httpOnly` cookies). The bearer token and
 * the cookie value are the same session token, so this is copying one value, not syncing two
 * credentials. Only works for origins in `manifest.ts`'s `host_permissions`.
 */
import { DASHBOARD_DEV_ORIGINS, EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';

/**
 * Origins a dashboard session cookie may live on: the backend first (a deployed, cross-origin
 * dashboard), then the local dev-server origins (see `DASHBOARD_DEV_ORIGINS`).
 */
const SHARED_SESSION_ORIGINS = [EXTENSION_BACKEND_ORIGIN, ...DASHBOARD_DEV_ORIGINS];

/**
 * Better Auth's default session cookie name (`auth.ts` keeps the default prefix). Must change if
 * that config does.
 */
const SESSION_COOKIE_NAME = 'better-auth.session_token';

/** Matches `auth.ts`'s `session.expiresIn` (7 days) — how long a cookie this writes should live. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Cookie values are stored percent-encoded (`%2B`, `%3D`); the token must be decoded. */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Whether `chrome.cookies` exists — it can be missing mid-update, before a restart grants the new
 * `cookies` permission.
 */
function hasCookiesApi(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.cookies);
}

/**
 * The dashboard's session token from its cookie, or `undefined` (absent, expired, or inaccessible).
 * Tries every origin in {@link SHARED_SESSION_ORIGINS}, since a missing permission looks the same
 * as a missing cookie.
 */
export async function getSharedSessionToken(): Promise<string | undefined> {
  if (!hasCookiesApi()) return undefined;
  for (const url of SHARED_SESSION_ORIGINS) {
    const cookie = await chrome.cookies.get({ url, name: SESSION_COOKIE_NAME });
    if (cookie) return decodeCookieValue(cookie.value);
  }
  return undefined;
}

/**
 * Writes `token` as the session cookie on every {@link SHARED_SESSION_ORIGINS} origin, so the
 * dashboard shares this sign-in. Each write is independent (`allSettled`).
 *
 * Attributes mirror `auth.ts`'s dev defaults: `httpOnly`, `secure` from each origin's scheme
 * (`chrome.cookies.set` rejects `secure` on `http://`), `sameSite: 'lax'`. A deployed backend using
 * `sameSite: 'none'` would need this revisited.
 */
export async function setSharedSessionToken(token: string): Promise<void> {
  if (!hasCookiesApi()) return;
  await Promise.allSettled(
    SHARED_SESSION_ORIGINS.map((url) => {
      const secure = url.startsWith('https://');
      return chrome.cookies.set({
        url,
        name: SESSION_COOKIE_NAME,
        value: encodeURIComponent(token),
        path: '/',
        httpOnly: true,
        secure,
        sameSite: secure ? 'no_restriction' : 'lax',
        expirationDate: Date.now() / 1000 + SESSION_MAX_AGE_SECONDS,
      });
    }),
  );
}

/**
 * Removes the session cookie from every origin, so signing out here also signs out dashboard tabs
 * locally.
 */
export async function clearSharedSessionToken(): Promise<void> {
  if (!hasCookiesApi()) return;
  await Promise.allSettled(
    SHARED_SESSION_ORIGINS.map((url) => chrome.cookies.remove({ url, name: SESSION_COOKIE_NAME })),
  );
}
