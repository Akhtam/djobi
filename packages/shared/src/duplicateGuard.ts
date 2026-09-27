import { failureMessage } from './failureMessage.js';
import type { ApplicationStage } from './schemas.js';
import type { DuplicateApplicationSummary } from './wire.js';

/**
 * What the candidate already has on file for a posting — a flat summary, not the whole Application,
 * since the guard does no analysis work and callers only need these fields.
 */
export interface DuplicateApplication {
  id: string;
  company: string;
  roleTitle: string;
  /** Shown because it matters: `onsite` is live, an old `rejected` may be worth retrying. */
  stage: ApplicationStage;
  /** The *most recent* save for this posting — the lookup returns matches newest-first. */
  createdAt: string;
  /**
   * How many saved applications share this posting. Greater than one means repeated applications.
   */
  count: number;
}

/**
 * The one backend method the guard needs. `signal` is optional: the dashboard's client takes none.
 */
export interface DuplicateLookup {
  findApplicationDuplicates(
    jobUrl: string,
    signal?: AbortSignal,
  ): Promise<DuplicateApplicationSummary>;
}

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
 * The newest Application saved for `jobUrl`'s posting plus a count, or `null` when there is none,
 * no URL, or the lookup failed. Fails open: a failure is logged and the candidate keeps working.
 * Every caller (Application Pipeline, Log tab, dashboard) goes through this one function.
 *
 * @throws Only the caller's own abort, so a superseded run can't continue as "no duplicates".
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
