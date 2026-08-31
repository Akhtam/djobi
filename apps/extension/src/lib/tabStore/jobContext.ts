/**
 * The Job Description a candidate collected for this tab before any Analysis Step ran.
 *
 * Retained across the ATS routes that belong to one posting — an overview page and the `/apply`
 * screen behind it — which is why it is scoped by Job Key rather than by URL. The pure URL rules it
 * is scoped by are `lib/jobContext.ts`; keeping the draft is this module's, and keeping the two
 * apart is what stops a persistence concern from being added to a module `tabStore/record.ts`
 * itself imports.
 */
import { jobKeyForUrl, type JobContext, type JobDescriptionSource } from '../jobContext';
import { read, withTabLock, write } from './record';

/** The retained pre-analysis Job Description for this tab, if one has been supplied. */
export async function getJobContext(tabId: number): Promise<JobContext | null> {
  return (await read(tabId)).jobContext;
}

/**
 * Persists the editable pre-analysis draft through the service worker's per-tab write queue.
 * Clearing the editor removes the context instead of leaving an empty draft that can be restored.
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
