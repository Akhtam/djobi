import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveTab } from './useActiveTab';

/**
 * These four `chrome.tabs` touchpoints used to live inline in `panel/App.tsx`, where reaching them
 * meant rendering the whole panel with a profile loaded. The extraction is what makes the
 * tab-following rules assertable on their own.
 */
function stubChrome(initial: { id?: number; url?: string } = { id: 1, url: 'https://acme.com/a' }) {
  const activated: ((info: chrome.tabs.OnActivatedInfo) => void)[] = [];
  const updated: ((tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => void)[] = [];
  const tabsById = new Map<number, { id: number; url: string }>();

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn((_q: unknown, callback: (tabs: unknown[]) => void) => callback([initial])),
      get: vi.fn((tabId: number, callback: (tab: unknown) => void) =>
        callback(tabsById.get(tabId) ?? { id: tabId }),
      ),
      onActivated: {
        addListener: vi.fn((l: (typeof activated)[number]) => activated.push(l)),
        removeListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn((l: (typeof updated)[number]) => updated.push(l)),
        removeListener: vi.fn(),
      },
    },
  });

  return {
    knowTab: (id: number, url: string) => tabsById.set(id, { id, url }),
    activate: (tabId: number) => activated.forEach((l) => l({ tabId, windowId: 1 })),
    navigate: (tabId: number, url: string) =>
      updated.forEach((l) => l(tabId, { url } as chrome.tabs.OnUpdatedInfo)),
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

  it('stops listening on unmount', async () => {
    stubChrome();
    const { result, unmount } = renderHook(() => useActiveTab(true));
    await waitFor(() => expect(result.current.tabId).toBe(1));

    unmount();

    expect(chrome.tabs.onActivated.removeListener).toHaveBeenCalled();
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalled();
  });
});
