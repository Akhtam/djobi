import { vi } from 'vitest';

/**
 * In-memory stand-in for `chrome.cookies`, for tests. Not imported by anything that ships.
 *
 * One store, keyed by name — enough for `sharedSessionCookie.ts`'s single-cookie usage, which is
 * the only thing any test touching this fake needs to exercise. `get`/`set`/`remove` resolve the
 * same shapes the real `chrome.cookies` promises do.
 */
export function fakeCookies() {
  const store = new Map<string, chrome.cookies.Cookie>();

  return {
    store,
    get: vi.fn(async ({ name }: chrome.cookies.CookieDetails) => store.get(name) ?? null),
    set: vi.fn(async (details: chrome.cookies.SetDetails) => {
      const cookie = {
        domain: '127.0.0.1',
        name: details.name ?? '',
        value: details.value ?? '',
        session: details.expirationDate === undefined,
        hostOnly: true,
        expirationDate: details.expirationDate,
        path: details.path ?? '/',
        httpOnly: details.httpOnly ?? false,
        secure: details.secure ?? false,
        sameSite: details.sameSite ?? 'unspecified',
        storeId: '0',
      } as chrome.cookies.Cookie;
      store.set(cookie.name, cookie);
      return cookie;
    }),
    remove: vi.fn(async ({ name, url }: chrome.cookies.CookieDetails) => {
      store.delete(name);
      return { name, url };
    }),
  };
}
