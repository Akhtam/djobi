import { useEffect, useState } from 'react';

/**
 * The tab the panel is about. The side panel survives tab switches, so it re-tracks via
 * `chrome.tabs` (`query`, `get`, `onActivated`, `onUpdated`).
 *
 * `changeToken` increments on every switch and same-tab navigation, for page-scoped resets;
 * job-scoped state compares Job Context instead, so overview → application routes keep it.
 */
export interface ActiveTab {
  tabId: number | null;
  tabUrl: string | null;
  /** Increments whenever the tracked page changes — a different tab, or a navigation within one. */
  changeToken: number;
}

/** Tracks the active tab through switches and navigations, once `enabled`. */
export function useActiveTab(enabled: boolean): ActiveTab {
  const [tab, setTab] = useState<ActiveTab>({ tabId: null, tabUrl: null, changeToken: 0 });

  useEffect(() => {
    if (!enabled) return;

    let current = true;
    let requestToken = 0;
    let trackedTabId: number | null = null;
    /**
     * Points the panel at a page, bumping the token so callers reset what was scoped to the last
     * one.
     */
    function track(tabId: number, tabUrl: string | null) {
      if (!current) return;
      trackedTabId = tabId;
      setTab((prev) => ({ tabId, tabUrl, changeToken: prev.changeToken + 1 }));
    }

    const queryToken = ++requestToken;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!current || queryToken !== requestToken) return;
      const active = tabs[0];
      if (active?.id !== undefined) track(active.id, active.url ?? null);
    });

    function onActivated(activeInfo: chrome.tabs.OnActivatedInfo) {
      const activationToken = ++requestToken;
      // Claim the newly active tab before its URL lookup completes. A late navigation event from
      // the old tab must not invalidate this activation callback and switch the panel back.
      trackedTabId = activeInfo.tabId;
      setTab((prev) => ({
        tabId: activeInfo.tabId,
        tabUrl: null,
        changeToken: prev.changeToken + 1,
      }));
      chrome.tabs.get(activeInfo.tabId, (activated) => {
        if (!current || activationToken !== requestToken) return;
        setTab((prev) =>
          prev.tabId === activeInfo.tabId ? { ...prev, tabUrl: activated.url ?? null } : prev,
        );
      });
    }

    // `changeInfo.url` is set only on a real navigation, so this ignores the other reasons a tab
    // updates (title, favicon, load state) — none of which mean a different application.
    function onUpdated(updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
      const tabUrl = changeInfo.url;
      if (updatedTabId !== trackedTabId || !tabUrl) return;
      ++requestToken;
      trackedTabId = updatedTabId;
      setTab((prev) => {
        return { tabId: updatedTabId, tabUrl, changeToken: prev.changeToken + 1 };
      });
    }

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      current = false;
      ++requestToken;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [enabled]);

  return tab;
}
