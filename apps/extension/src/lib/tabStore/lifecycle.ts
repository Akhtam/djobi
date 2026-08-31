/**
 * When a tab's record is dropped: navigation, and the tab closing.
 *
 * Navigation is not a clear. Frames are page-specific and always go, while the run and the retained
 * Job Context survive a move between routes of the same posting — which is why cleanup is a rule
 * here rather than a `removeRecord` on every event.
 */
import { isSameJobUrl } from '../jobContext';
import { read, removeRecord, withTabLock, write } from './record';

export async function clearTabState(tabId: number): Promise<void> {
  return removeRecord(tabId);
}

/**
 * Drops page-specific frames on every navigation while retaining data that still belongs to the
 * same job. A different posting clears everything; closing the tab always clears everything.
 */
export async function handleTabNavigation(tabId: number, nextUrl: string): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const jobContext =
      state.jobContext && isSameJobUrl(state.jobContext.sourceUrl, nextUrl)
        ? state.jobContext
        : null;
    const run = state.run && isSameJobUrl(state.run.tabUrl, nextUrl) ? state.run : null;
    await write(tabId, { frames: {}, jobContext, run });
  });
}

/** Wires service-worker invalidation for tab closure and navigation. */
export function registerTabStateCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearTabState(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url !== undefined) void handleTabNavigation(tabId, changeInfo.url);
  });
}
