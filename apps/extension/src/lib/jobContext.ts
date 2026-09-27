import { jobKeyForUrl, z, type ZodTypeOf } from '@djobi/shared';

/** Re-exported from `@djobi/shared` (the backend's Duplicate Guard uses the same key). */
export { jobKeyForUrl, isSameJobUrl } from '@djobi/shared';

/** Where the editable Job Description draft originally came from. */
export const JobDescriptionSourceSchema = z.enum(['manual', 'scraped']);
export type JobDescriptionSource = ZodTypeOf<typeof JobDescriptionSourceSchema>;

/**
 * The Job Description for the job open in a tab. Separate from a run because candidates often
 * collect the posting on an overview route and analyze after navigating to the application route.
 */
export interface JobContext {
  /** Stable across overview/application routes for the same posting — see {@link jobKeyForUrl}. */
  jobKey: string;
  /** The page the description came from; used as the canonical saved/duplicate-check URL. */
  sourceUrl: string;
  jobDescription: string;
  source: JobDescriptionSource;
}
