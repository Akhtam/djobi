import { useEffect, useState } from 'react';

/**
 * The tab the panel is currently about.
 *
 * The side panel survives a tab switch — unlike a popup, which is destroyed by any outside click —
 * so it has to re-track rather than remount. That means four `chrome.tabs` touchpoints (`query` at
 * startup, `get` on activation, and the `onActivated`/`onUpdated` listeners), which lived inline in
 * `App.tsx` and were most of what its test had to stub. Here they are one seam.
 *
 * `changeToken` increments on every switch *and* on a same-tab navigation. The panel uses it to
 * drop everything scoped to the page it was showing: a tab that navigates is a different job
 * application even though its id hasn't changed, so an id alone can't say when to reset.
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
    /** Points the panel at a page, bumping the token so callers reset what was scoped to the last one. */
    function track(tabId: number, tabUrl: string | null) {
      if (!current) return;
      setTab((prev) => ({ tabId, tabUrl, changeToken: prev.changeToken + 1 }));
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const active = tabs[0];
      if (active?.id !== undefined) track(active.id, active.url ?? null);
    });

    function onActivated(activeInfo: chrome.tabs.OnActivatedInfo) {
      chrome.tabs.get(activeInfo.tabId, (activated) =>
        track(activeInfo.tabId, activated.url ?? null),
      );
    }

    // `changeInfo.url` is set only on a real navigation, so this ignores the other reasons a tab
    // updates (title, favicon, load state) — none of which mean a different application.
    function onUpdated(updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
      setTab((prev) => {
        if (updatedTabId !== prev.tabId || !changeInfo.url) return prev;
        return { tabId: updatedTabId, tabUrl: changeInfo.url, changeToken: prev.changeToken + 1 };
      });
    }

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      current = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [enabled]);

  return tab;
}
