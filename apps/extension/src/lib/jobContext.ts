import { jobKeyForUrl } from '@djobi/shared';

/**
 * The job-posting URL identity now lives in `@djobi/shared`, because the backend's Duplicate Guard
 * matches on the same key and the two sides have to compute it identically. Re-exported here so the
 * panel and background keep importing their job-scoping helpers from one place.
 */
export { jobKeyForUrl, isSameJobUrl } from '@djobi/shared';

/** Where the editable Job Description draft originally came from. */
export type JobDescriptionSource = 'manual' | 'scraped';

/**
 * The Job Description that belongs to the job currently open in a tab.
 *
 * It is separate from an Analysis run because candidates commonly collect the posting on an ATS
 * overview route, then navigate to an application route before they analyze it. The draft therefore
 * has to exist before a run does and survive that same-job navigation.
 */
export interface JobContext {
  /** Stable across overview/application routes for the same posting — see {@link jobKeyForUrl}. */
  jobKey: string;
  /** The page the description came from; used as the canonical saved/duplicate-check URL. */
  sourceUrl: string;
  jobDescription: string;
  source: JobDescriptionSource;
}
