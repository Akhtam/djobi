/**
 * In-memory stand-in for the `chrome.*` surfaces this extension uses, for tests. `storage` is
 * `fakeSessionStorage`. Tests needing *deferred* callbacks to interleave races (e.g.
 * `panel/useActiveTab.test.ts`) keep their own fake.
 */
import { fakeSessionStorage, type FakeSessionStorage } from './fakeSessionStorage';
import { vi } from 'vitest';

type ActivatedListener = (info: chrome.tabs.OnActivatedInfo) => void;
type UpdatedListener = (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => void;
type RemovedListener = (tabId: number) => void;

export interface FakeChromeOptions {
  /** The active tab `chrome.tabs.query` reports. `null` for a window with no active tab. */
  tab?: { id: number; url?: string | null | undefined } | null | undefined;
  /** Share a store across two mounts — what a panel closing and reopening sees. */
  storage?: FakeSessionStorage | undefined;
  /** Answers `chrome.runtime.sendMessage`. The default records the call and replies `undefined`. */
  sendMessage?:
    ((message: Record<string, unknown>, callback: (response: unknown) => void) => void) | undefined;
}

export interface FakeChrome {
  /** The spies the extension calls, for tests that assert on what was sent. */
  sendMessage: ReturnType<typeof vi.fn>;
  openOptionsPage: ReturnType<typeof vi.fn>;
  storage: FakeSessionStorage;
  /** Teaches the fake a tab's URL, so `chrome.tabs.get` answers for it after an activation. */
  knowTab: (id: number, url: string | null) => void;
  /** Fires `chrome.tabs.onActivated` — the user switching tabs. */
  activate: (tabId: number) => void;
  /** Fires `chrome.tabs.onUpdated` with a URL change — a navigation within one tab. */
  navigate: (tabId: number, url: string) => void;
  /** Fires `chrome.tabs.onRemoved` — the tab being closed, which invalidates its stored state. */
  closeTab: (tabId: number) => void;
  /** Seeds the cookie `chrome.cookies.get` returns for `name` (for `sharedSessionCookie.ts`). */
  setCookie: (name: string, value: string | null) => void;
}

/** Installs a fake `chrome` global and returns its handles. Undone by `vi.unstubAllGlobals()`. */
export function fakeChrome(options: FakeChromeOptions = {}): FakeChrome {
  const activated: ActivatedListener[] = [];
  const updated: UpdatedListener[] = [];
  const removed: RemovedListener[] = [];
  const tabsById = new Map<number, { id: number; url?: string }>();

  const active = options.tab === undefined ? { id: 1, url: undefined } : options.tab;
  if (active)
    tabsById.set(active.id, { id: active.id, ...(active.url != null ? { url: active.url } : {}) });

  const storage = options.storage ?? fakeSessionStorage();
  const cookies = new Map<string, string>();
  const openOptionsPage = vi.fn();
  const sendMessage = vi.fn(
    (message: Record<string, unknown>, callback: (response: unknown) => void) => {
      if (options.sendMessage) return options.sendMessage(message, callback);
      callback(undefined);
    },
  );

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn((_query: unknown, callback: (tabs: { id: number; url?: string }[]) => void) =>
        callback(
          active ? [{ id: active.id, ...(active.url != null ? { url: active.url } : {}) }] : [],
        ),
      ),
      get: vi.fn((tabId: number, callback: (tab: { id: number; url?: string }) => void) =>
        callback(tabsById.get(tabId) ?? { id: tabId }),
      ),
      onActivated: {
        addListener: vi.fn((listener: ActivatedListener) => activated.push(listener)),
        removeListener: vi.fn((listener: ActivatedListener) => {
          const index = activated.indexOf(listener);
          if (index >= 0) activated.splice(index, 1);
        }),
      },
      onUpdated: {
        addListener: vi.fn((listener: UpdatedListener) => updated.push(listener)),
        removeListener: vi.fn((listener: UpdatedListener) => {
          const index = updated.indexOf(listener);
          if (index >= 0) updated.splice(index, 1);
        }),
      },
      onRemoved: {
        addListener: vi.fn((listener: RemovedListener) => removed.push(listener)),
        removeListener: vi.fn((listener: RemovedListener) => {
          const index = removed.indexOf(listener);
          if (index >= 0) removed.splice(index, 1);
        }),
      },
    },
    runtime: {
      sendMessage,
      openOptionsPage,
      lastError: undefined,
      // Answers the service-worker heartbeat (`lib/keepAlive.ts`). Every routed pipeline step calls
      // it, so a fake without it fails the panel tests for a reason that has nothing to do with
      // them.
      getPlatformInfo: () => Promise.resolve({ os: 'mac', arch: 'arm64', nacl_arch: 'arm64' }),
    },
    storage,
    // One cookie by name, no domain/path matching — all `sharedSessionCookie.ts` needs.
    cookies: {
      get: vi.fn(async (details: { name: string }) => {
        const value = cookies.get(details.name);
        return value === undefined ? null : { value };
      }),
      set: vi.fn(async (details: { name?: string; value?: string }) => {
        cookies.set(details.name ?? '', details.value ?? '');
        return { name: details.name ?? '', value: details.value ?? '' };
      }),
      remove: vi.fn(async (details: { name: string; url: string }) => {
        cookies.delete(details.name);
        return details;
      }),
    },
  });

  return {
    sendMessage,
    openOptionsPage,
    storage,
    setCookie: (name, value) => {
      if (value === null) cookies.delete(name);
      else cookies.set(name, value);
    },
    knowTab: (id, url) => tabsById.set(id, { id, ...(url != null ? { url } : {}) }),
    // Iterate a copy, as `fakeSessionStorage` does: a listener that removes itself mid-dispatch
    // would otherwise make the next one be skipped.
    activate: (tabId) => [...activated].forEach((listener) => listener({ tabId, windowId: 1 })),
    navigate: (tabId, url) =>
      [...updated].forEach((listener) => listener(tabId, { url } as chrome.tabs.OnUpdatedInfo)),
    closeTab: (tabId) => [...removed].forEach((listener) => listener(tabId)),
  };
}
