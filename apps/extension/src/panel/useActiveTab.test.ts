import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import { useActiveTab } from './useActiveTab';

/**
 * These four `chrome.tabs` touchpoints used to live inline in `panel/App.tsx`, where reaching them
 * meant rendering the whole panel with a profile loaded. The extraction is what makes the
 * tab-following rules assertable on their own.
 *
 * The fake itself is `lib/fakeChrome.ts` — the same one the panel's harness installs, so a change
 * to how Chrome is faked lands in one place. {@link stubDeferredChrome} below is the exception it
 * documents.
 */
function stubChrome(initial: { id?: number; url?: string } = { id: 1, url: 'https://acme.com/a' }) {
  const { knowTab, activate, navigate } = fakeChrome({
    tab: { id: initial.id ?? 1, url: initial.url },
  });
  return { knowTab, activate, navigate };
}

function stubDeferredChrome() {
  const activated: ((info: chrome.tabs.OnActivatedInfo) => void)[] = [];
  const updated: ((tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => void)[] = [];
  const queryCallbacks: ((tabs: chrome.tabs.Tab[]) => void)[] = [];
  const getCallbacks = new Map<number, (tab: chrome.tabs.Tab) => void>();

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn((_q: unknown, callback: (tabs: chrome.tabs.Tab[]) => void) =>
        queryCallbacks.push(callback),
      ),
      get: vi.fn((tabId: number, callback: (tab: chrome.tabs.Tab) => void) =>
        getCallbacks.set(tabId, callback),
      ),
      onActivated: {
        addListener: vi.fn((listener: (typeof activated)[number]) => activated.push(listener)),
        removeListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn((listener: (typeof updated)[number]) => updated.push(listener)),
        removeListener: vi.fn(),
      },
    },
  });

  return {
    resolveQuery: (id: number, url: string) => queryCallbacks[0]!([{ id, url } as chrome.tabs.Tab]),
    activate: (tabId: number) => activated.forEach((listener) => listener({ tabId, windowId: 1 })),
    resolveGet: (tabId: number, url: string) =>
      getCallbacks.get(tabId)?.({ id: tabId, url } as chrome.tabs.Tab),
    navigate: (tabId: number, url: string) =>
      updated.forEach((listener) => listener(tabId, { url } as chrome.tabs.OnUpdatedInfo)),
  };
}

describe('useActiveTab', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('does not touch chrome.tabs until enabled — the panel has nothing to show for a tab yet', () => {
    stubChrome();

    renderHook(() => useActiveTab(false));

    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.tabs.onActivated.addListener).not.toHaveBeenCalled();
  });

  it('reports the active tab once enabled', async () => {
    stubChrome({ id: 7, url: 'https://acme.com/jobs/1' });

    const { result } = renderHook(() => useActiveTab(true));

    await waitFor(() => expect(result.current.tabId).toBe(7));
    expect(result.current.tabUrl).toBe('https://acme.com/jobs/1');
  });

  it('follows a tab switch, since the panel survives one instead of remounting', async () => {
    const { activate, knowTab } = stubChrome({ id: 7, url: 'https://acme.com/jobs/1' });
    knowTab(9, 'https://other.com/jobs/2');
    const { result } = renderHook(() => useActiveTab(true));
    await waitFor(() => expect(result.current.tabId).toBe(7));

    act(() => activate(9));

    await waitFor(() => expect(result.current.tabId).toBe(9));
    expect(result.current.tabUrl).toBe('https://other.com/jobs/2');
  });

  it('does not switch back when activation callbacks resolve in reverse order', () => {
    const { activate, resolveGet, resolveQuery } = stubDeferredChrome();
    const { result } = renderHook(() => useActiveTab(true));
    act(() => resolveQuery(1, 'https://acme.com/jobs/1'));

    act(() => {
      activate(2);
      activate(3);
      resolveGet(3, 'https://acme.com/jobs/3');
      resolveGet(2, 'https://acme.com/jobs/2');
    });

    expect(result.current.tabId).toBe(3);
    expect(result.current.tabUrl).toBe('https://acme.com/jobs/3');
  });

  it('ignores the initial query when it resolves after a newer activation', () => {
    const { activate, resolveGet, resolveQuery } = stubDeferredChrome();
    const { result } = renderHook(() => useActiveTab(true));

    act(() => {
      activate(2);
      resolveGet(2, 'https://acme.com/jobs/2');
      resolveQuery(1, 'https://acme.com/jobs/1');
    });

    expect(result.current.tabId).toBe(2);
    expect(result.current.tabUrl).toBe('https://acme.com/jobs/2');
  });

  it('bumps changeToken on a same-tab navigation — a new page is a new application, same id', async () => {
    const { navigate } = stubChrome({ id: 7, url: 'https://acme.com/jobs/1' });
    const { result } = renderHook(() => useActiveTab(true));
    await waitFor(() => expect(result.current.tabId).toBe(7));
    const before = result.current.changeToken;

    act(() => navigate(7, 'https://acme.com/jobs/2'));

    expect(result.current.tabUrl).toBe('https://acme.com/jobs/2');
    expect(result.current.changeToken).toBe(before + 1);
  });

  it('ignores an update to a tab it is not tracking', async () => {
    const { navigate } = stubChrome({ id: 7, url: 'https://acme.com/jobs/1' });
    const { result } = renderHook(() => useActiveTab(true));
    await waitFor(() => expect(result.current.tabId).toBe(7));
    const before = result.current.changeToken;

    act(() => navigate(99, 'https://elsewhere.com'));

    expect(result.current.tabUrl).toBe('https://acme.com/jobs/1');
    expect(result.current.changeToken).toBe(before);
  });

  it('ignores an update carrying no url — a title or favicon change is not a new application', async () => {
    const { navigate } = stubChrome({ id: 7, url: 'https://acme.com/jobs/1' });
    const { result } = renderHook(() => useActiveTab(true));
    await waitFor(() => expect(result.current.tabId).toBe(7));
    const before = result.current.changeToken;

    act(() => navigate(7, undefined as unknown as string));

    expect(result.current.changeToken).toBe(before);
  });

  it('keeps the newly activated tab when the previously tracked tab navigates', () => {
    const { activate, navigate, resolveGet, resolveQuery } = stubDeferredChrome();
    const { result } = renderHook(() => useActiveTab(true));
    act(() => resolveQuery(1, 'https://acme.com/jobs/1'));

    act(() => activate(2));
    expect(result.current.tabId).toBe(2);
    expect(result.current.tabUrl).toBeNull();

    act(() => {
      navigate(1, 'https://acme.com/jobs/1/edit');
      resolveGet(2, 'https://acme.com/jobs/2');
    });

    expect(result.current.tabId).toBe(2);
    expect(result.current.tabUrl).toBe('https://acme.com/jobs/2');
  });

  it('stops listening on unmount', async () => {
    stubChrome();
    const { result, unmount } = renderHook(() => useActiveTab(true));
    await waitFor(() => expect(result.current.tabId).toBe(1));

    unmount();

    expect(chrome.tabs.onActivated.removeListener).toHaveBeenCalled();
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalled();
  });
});
