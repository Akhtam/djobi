import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { fakeSessionStorage } from './fakeSessionStorage';
import { clearAuthToken, getAuthToken, setAuthToken } from './authToken';

beforeEach(() => {
  vi.stubGlobal('chrome', { storage: fakeSessionStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authToken', () => {
  it('resolves undefined before a token is ever stored', async () => {
    await expect(getAuthToken()).resolves.toBeUndefined();
  });

  it('round-trips a token through chrome.storage.session', async () => {
    await setAuthToken('the-token');
    await expect(getAuthToken()).resolves.toBe('the-token');
  });

  it('resolves undefined again after clearAuthToken', async () => {
    await setAuthToken('the-token');
    await clearAuthToken();
    await expect(getAuthToken()).resolves.toBeUndefined();
  });

  it('replaces a previously stored token rather than merging with it', async () => {
    await setAuthToken('first');
    await setAuthToken('second');
    await expect(getAuthToken()).resolves.toBe('second');
  });
});
