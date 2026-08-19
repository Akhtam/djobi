import { useEffect, useState } from 'react';

/**
 * The tab the panel is currently about.
 *
 * The side panel survives a tab switch — unlike a popup, which is destroyed by any outside click —
 * so it has to re-track rather than remount. That means four `chrome.tabs` touchpoints (`query` at
 * startup, `get` on activation, and the `onActivated`/`onUpdated` listeners), which lived inline in
 * `App.tsx` and were most of what its test had to stub. Here they are one seam.
 *
 * `changeToken` increments on every switch *and* on a same-tab navigation. Page-scoped consumers
 * use it to reset form detection and pending requests; job-scoped consumers separately compare a
 * canonical Job Context so an ATS overview -> application route can retain its description/run.
 */
export interface ActiveTab {
  tabId: number | null;
  tabUrl: string | null;
  /** Increments whenever the tracked page changes — a different tab, or a navigation within one. */
  changeToken: number;
}

/**
 * Tracks the active tab, and follows it as the user switches tabs or navigates.
 *
 * Tracking doesn't start until `enabled`, so the panel doesn't chase tabs while it is still showing
 * its "set up your profile" state and has nothing to show for one.
 */
export function useActiveTab(enabled: boolean): ActiveTab {
  const [tab, setTab] = useState<ActiveTab>({ tabId: null, tabUrl: null, changeToken: 0 });

  useEffect(() => {
    if (!enabled) return;

    let current = true;
    let requestToken = 0;
    let trackedTabId: number | null = null;
    /** Points the panel at a page, bumping the token so callers reset what was scoped to the last one. */
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
