/**
 * The per-tab toolbar badge saying an application was recorded — the confirmation of last resort.
 * An auto-save follows the ATS's own submit, which navigates away (so the toast may never show) and
 * the panel is usually closed; Chrome's badge survives the navigation.
 */

const SAVED_TEXT = '✓';
const SAVED_BACKGROUND = '#1f9d55';

/**
 * Marks `tabId` as having a saved application. Swallows failures (the tab may already be closed): a
 * badge must never fail the save it reports.
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
