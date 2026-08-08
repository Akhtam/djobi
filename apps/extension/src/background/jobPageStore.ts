import type { DetectedField } from '@djobi/shared';

/** What the content script reports once it's detected and scraped an ATS job application page. */
export interface JobPageData {
  pageText: string;
  fields: DetectedField[];
}

/**
 * Per-tab store for the most recently reported {@link JobPageData}. The content script reports
 * into this on page load; the popup reads it back for the active tab when it opens (popups have
 * no persistent lifetime of their own, so this is the hand-off point between the two).
 */
const jobPageDataByTab = new Map<number, JobPageData>();

export function setJobPageData(tabId: number, data: JobPageData): void {
  jobPageDataByTab.set(tabId, data);
}

export function getJobPageData(tabId: number): JobPageData | null {
  return jobPageDataByTab.get(tabId) ?? null;
}
