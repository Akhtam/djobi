/**
 * The Duplicate Guard: what the candidate already has on file for the posting they are about to
 * record, and the rule that a failed lookup must never be the reason they can't record it.
 *
 * One module because there are two surfaces, and they had drifted into opposite failure policies.
 * The Application Pipeline caught a failed lookup and analyzed anyway. The Log Tab ran the same
 * lookup inside a `Promise.all` beside `extractJob`, so a backend hiccup rejected the pair and the
 * candidate was shown an extraction error — for an extraction that had *succeeded*, whose model
 * call was then thrown away. A guard that exists to save someone from re-applying had become the
 * thing stopping them from recording that they had.
 *
 * So the policy is stated in the interface rather than left to each caller's `try`: **this resolves
 * or it is a cancellation.** There is no failure mode for a caller to get wrong, which is what
 * makes the rule in `CONTEXT.md` — "fails open" — true of the code rather than true of one copy of
 * it.
 *
 * Matching is the backend's: on the **Job Key**, the posting's URL identity, so a posting revisited
 * through an ad link or from the `/apply` screen resolves to the earlier Application rather than
 * reading as a new job.
 */
import { failureMessage, type DuplicateApplicationSummary } from '@djobi/shared';
import type { BackendClient } from './backendClient';
import type { DuplicateApplication } from './run';

/** Just enough of the backend to run the guard — so a caller can substitute one method, not eleven. */
export type DuplicateLookup = Pick<BackendClient, 'findApplicationDuplicates'>;

/** Projects the transport's paired count/latest result into the flattened run-domain summary. */
export function duplicateApplicationOf(
  summary: DuplicateApplicationSummary,
): DuplicateApplication | null {
  if (!summary.latest) return null;
  return {
    id: summary.latest.id,
    company: summary.latest.company,
    roleTitle: summary.latest.roleTitle,
    stage: summary.latest.stage,
    createdAt: summary.latest.createdAt,
    count: summary.count,
  };
}

/**
 * The newest Application saved against `jobUrl`'s posting, with how many there are — or `null` when
 * there are none, when there is no URL to match on, or when the lookup failed.
 *
 * Those three are deliberately one answer. The guard's whole purpose is to *warn*, so every reason
 * it can't warn ends the same way: the candidate keeps working. A failed lookup is logged, not
 * raised, and there is no uniqueness constraint on `job_url` that would make it authoritative
 * anyway.
 *
 * @throws Only the caller's own cancellation. A run the candidate superseded must not resume as
 *   "no duplicates found" and go on to spend a model call — an abort is the one failure here that
 *   is not about the lookup.
 */
export async function findDuplicate(
  backend: DuplicateLookup,
  jobUrl: string | null,
  signal?: AbortSignal,
): Promise<DuplicateApplication | null> {
  if (!jobUrl) return null; // no URL to match on — Chrome hasn't exposed one for this tab

  try {
    return duplicateApplicationOf(await backend.findApplicationDuplicates(jobUrl, signal));
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`[djobi] duplicate check failed, continuing without it: ${failureMessage(error)}`);
    return null;
  }
}
