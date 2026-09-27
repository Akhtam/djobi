/**
 * When a tab's record is dropped. Navigation always drops frames but keeps the run and Job Context
 * within the same posting; a different posting or closing the tab clears everything.
 */
import { isSameJobUrl } from '../jobContext';
import { read, removeRecord, withTabLock, write } from './record';

export async function clearTabState(tabId: number): Promise<void> {
  return removeRecord(tabId);
}

/** Drops frames on navigation, keeping same-job data; a different posting clears everything. */
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
