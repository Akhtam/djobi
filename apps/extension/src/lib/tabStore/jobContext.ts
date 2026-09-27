/**
 * Persists the Job Description collected for a tab before any analysis, scoped by Job Key so it
 * survives same-posting routes (overview → `/apply`). The URL rules are `lib/jobContext.ts`'s.
 */
import { jobKeyForUrl, type JobContext, type JobDescriptionSource } from '../jobContext';
import { read, withTabLock, write } from './record';

/** The retained pre-analysis Job Description for this tab, if one has been supplied. */
export async function getJobContext(tabId: number): Promise<JobContext | null> {
  return (await read(tabId)).jobContext;
}

/**
 * Persists the pre-analysis draft through the per-tab write queue. Clearing the editor removes the
 * context rather than storing an empty draft.
 */
export async function setJobContext(
  tabId: number,
  sourceUrl: string,
  jobDescription: string,
  source: JobDescriptionSource,
): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const jobKey = jobKeyForUrl(sourceUrl);
    if (!jobKey) return;

    if (!jobDescription.trim()) {
      await write(tabId, { ...state, jobContext: null });
      return;
    }

    const existing = state.jobContext?.jobKey === jobKey ? state.jobContext : null;
    await write(tabId, {
      ...state,
      jobContext: {
        jobKey,
        // Keep the overview URL once captured; an `/application` edit must not replace the URL used
        // by Duplicate Guard and Save with a less useful route.
        sourceUrl: existing?.sourceUrl ?? sourceUrl,
        jobDescription,
        source: existing?.source === 'scraped' ? 'scraped' : source,
      },
    });
  });
}
