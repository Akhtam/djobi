/**
 * The dashboard's session, as the extension can also reach it: Better Auth's own session cookie on
 * the backend's origin, read and written through `chrome.cookies` rather than `document.cookie` —
 * the one thing an extension can do with an `httpOnly` cookie that a page's own script can't.
 *
 * The reason this is worth doing at all: a bearer token and a session cookie aren't two credentials
 * that happen to authenticate the same account, they're two transports for the *same* Better Auth
 * session. `set-auth-token` (what `authClient.ts`'s `signIn` stores) and this cookie's value are
 * byte-identical — confirmed by sending a copied cookie value straight back as `Authorization:
 * Bearer <value>` and getting a real `200`. So "sync the sessions" is just "read/write the one
 * value both sides already agree means the same thing," not a second credential to keep consistent
 * with the first.
 *
 * `chrome.cookies` only reaches an origin this extension holds a host permission for —
 * `EXTENSION_BACKEND_ORIGIN` is one of `manifest.ts`'s `host_permissions` already, for the same
 * reason `callBackend.ts` needs no CORS entry to call it directly.
 */
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';

/**
 * Better Auth's default session-cookie name (`${cookiePrefix}.session_token`, `cookiePrefix`
 * defaulting to `"better-auth"`). `auth.ts` doesn't override `advanced.cookiePrefix`, so this is
 * exactly the name a real sign-in sets — verified directly against a running backend. If that
 * config ever changes, this constant has to change with it; nothing derives it automatically.
 */
const SESSION_COOKIE_NAME = 'better-auth.session_token';

/** Matches `auth.ts`'s `session.expiresIn` (7 days) — how long a cookie this writes should live. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/**
 * A cookie value is stored percent-encoded — confirmed against a real `Set-Cookie` response, whose
 * `+`/`=` characters came back as `%2B`/`%3D`. `chrome.cookies.get` returns that raw stored string,
 * not the decoded token `set-auth-token` carries; without this, a token adopted from the cookie
 * would carry literal `%2B`s a signature check elsewhere would reject.
 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * True once `chrome.cookies` is actually there to call. Guards every function below against two
 * real cases, not just a test environment that stubs `chrome` without it: an extension context
 * that predates this module (mid-update, before the user has restarted the browser to pick up the
 * newly-declared `cookies` permission) sees the same absence.
 */
function hasCookiesApi(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.cookies);
}

/**
 * The dashboard's session token, read directly from its cookie — or `undefined` if there isn't
 * one, it's expired, or this browser has no access to it (`chrome.cookies.get` can resolve `null`
 * for the first two; {@link hasCookiesApi} covers the third).
 */
export async function getSharedSessionToken(): Promise<string | undefined> {
  if (!hasCookiesApi()) return undefined;
  const cookie = await chrome.cookies.get({
    url: EXTENSION_BACKEND_ORIGIN,
    name: SESSION_COOKIE_NAME,
  });
  return cookie ? decodeCookieValue(cookie.value) : undefined;
}

/**
 * Writes `token` as the dashboard's session cookie, so a dashboard tab reaching
 * `EXTENSION_BACKEND_ORIGIN` authenticates as the same session this extension just signed in to —
 * without this, a sign-in here would only ever be visible to this extension.
 *
 * Attributes mirror `auth.ts`'s `defaultCookieAttributes` as closely as a `chrome.cookies.set` call
 * can: `httpOnly` (never readable from the dashboard's own `document.cookie`, same as a cookie
 * Better Auth set itself), `secure` derived from the origin's own scheme rather than hardcoded —
 * `chrome.cookies.set` rejects `secure: true` against a plain `http://` url outright, which is
 * exactly the dev-vs-deployed split `auth.ts`'s own comment walks through. `sameSite: 'lax'`
 * matches the same dev default; a deployed backend on a real origin needs this revisited alongside
 * `auth.ts`'s own `NODE_ENV`-gated `'none'`, since a content-script-inaccessible constant here has
 * no equivalent way to read that env var.
 */
export async function setSharedSessionToken(token: string): Promise<void> {
  if (!hasCookiesApi()) return;
  const secure = EXTENSION_BACKEND_ORIGIN.startsWith('https://');
  await chrome.cookies.set({
    url: EXTENSION_BACKEND_ORIGIN,
    name: SESSION_COOKIE_NAME,
    value: encodeURIComponent(token),
    path: '/',
    httpOnly: true,
    secure,
    sameSite: secure ? 'no_restriction' : 'lax',
    expirationDate: Date.now() / 1000 + SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Removes the dashboard's session cookie — the other half of this extension's own sign-out. Without
 * it, signing out here would leave a dashboard tab still holding (and sending) a cookie for a
 * session `POST /api/auth/sign-out` already invalidated server-side; the next authenticated call it
 * makes still 401s and routes to login, just one request later than it could have.
 */
export async function clearSharedSessionToken(): Promise<void> {
  if (!hasCookiesApi()) return;
  await chrome.cookies.remove({ url: EXTENSION_BACKEND_ORIGIN, name: SESSION_COOKIE_NAME });
}
