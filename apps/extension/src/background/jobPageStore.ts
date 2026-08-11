import type { JobPageData } from '../lib/messages';

/**
 * Per-tab store for the most recently reported {@link JobPageData}. The content script reports
 * into this on page load; the panel reads it back for the active tab once mounted — this is the
 * hand-off point between the two, since the content script can report before the panel opens.
 */
const jobPageDataByTab = new Map<number, JobPageData>();

export function setJobPageData(tabId: number, data: JobPageData): void {
  jobPageDataByTab.set(tabId, data);
}

export function getJobPageData(tabId: number): JobPageData | null {
  return jobPageDataByTab.get(tabId) ?? null;
}
