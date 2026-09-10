/**
 * The toolbar badge that says an application was recorded for this tab.
 *
 * The confirmation of last resort. An auto-save is triggered by the candidate submitting the ATS's
 * own form, which navigates the tab and tears down the content script — so the in-page toast
 * (`content/savedToast.ts`) may never render, and the side panel is usually closed. The badge is
 * owned by Chrome, is scoped to the tab, and survives the navigation, so it is the one surface that
 * can be relied on to still be there afterwards.
 *
 * Per-tab (`tabId` on every call) rather than global: a badge set on the tab a submission happened
 * in must not appear over every other tab's icon.
 */

const SAVED_TEXT = '✓';
const SAVED_BACKGROUND = '#1f9d55';

/**
 * Marks `tabId` as having a saved application.
 *
 * Swallows failures deliberately: the tab may already be gone by the time the write lands (closing
 * the tab right after submitting is an ordinary thing to do), and a badge that could not be drawn
 * must never fail the save it is reporting on.
 */
export async function showSavedBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: SAVED_BACKGROUND });
    await chrome.action.setBadgeText({ tabId, text: SAVED_TEXT });
  } catch {
    // Tab gone, or no action for it. Nothing to report and nothing to retry.
  }
}

/** Clears the badge — a new run on this tab is not the saved one the badge was about. */
export async function clearSavedBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // Same as above.
  }
}
