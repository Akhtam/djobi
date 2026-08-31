/** Test-only entry point for records written by an older extension build. */
export async function seedLegacyTabState(tabId: number, state: unknown): Promise<void> {
  await chrome.storage.session.set({ [`tab:${tabId}`]: state });
}
