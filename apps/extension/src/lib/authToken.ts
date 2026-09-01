/**
 * The extension's bearer token — `chrome.storage.session`, not `storage.local`.
 *
 * `docs/multi-tenant-auth.md`, Phase D: session storage is in-memory, is not written to disk, and
 * is not exposed to content scripts, and it survives service worker eviction, which is exactly the
 * property the MV3 durability work already relies on for a pipeline run. `storage.local` is
 * unencrypted on disk and currently holds only the theme; it should not start holding credentials.
 * The cost — re-authenticating after the browser restarts — is a trade made deliberately, not by
 * default.
 */
const STORAGE_KEY = 'authToken';

/** The stored token, or `undefined` before sign-in (or after `clearAuthToken`). */
export async function getAuthToken(): Promise<string | undefined> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const token = stored[STORAGE_KEY];
  return typeof token === 'string' ? token : undefined;
}

export async function setAuthToken(token: string): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: token });
}

export async function clearAuthToken(): Promise<void> {
  await chrome.storage.session.remove(STORAGE_KEY);
}
