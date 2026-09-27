/**
 * The extension's bearer token, in `chrome.storage.session`: in memory, never on disk, hidden from
 * content scripts, and it survives worker eviction. The trade-off — signing in again after a
 * browser restart — is deliberate.
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
