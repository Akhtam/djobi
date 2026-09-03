import { failureMessage } from './failureMessage.js';
import type { ApplicationStage } from './schemas.js';
import type { DuplicateApplicationSummary } from './wire.js';

/**
 * What the candidate already has on file for this job posting, when the Duplicate Guard finds one.
 *
 * A flattened summary rather than the whole `Application`: a caller needs five fields to explain
 * itself — the panel's Run Notice, the Log tab's and the dashboard's review screens — and carrying
 * the full record would mean a tailored resume and every answer riding along for a check that
 * deliberately did no analysis work.
 */
export interface DuplicateApplication {
  id: string;
  company: string;
  roleTitle: string;
  /**
   * Where that past application got to. Shown because it changes what the notice means: an
   * `onsite` row is a live process, a `rejected` one from a year ago may be worth retrying.
   */
  stage: ApplicationStage;
  /** The *most recent* save for this posting — the lookup returns matches newest-first. */
  createdAt: string;
  /** How many saved applications share this posting. Greater than one means repeated applications. */
  count: number;
}

/**
 * Just enough of a backend client to run the guard — so a caller can substitute one method, not its
 * whole client. `signal` is optional because not every caller has one to cancel with: the
 * extension's `BackendClient` accepts it, the dashboard's `DashboardClient` doesn't, and a function
 * typed for fewer parameters satisfies a caller expecting more.
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
 * The newest Application saved against `jobUrl`'s posting, with how many there are — or `null` when
 * there are none, when there is no URL to match on, or when the lookup failed.
 *
 * Those three are deliberately one answer. The guard's whole purpose is to *warn*, so every reason
 * it can't warn ends the same way: the candidate keeps working. A failed lookup is logged, not
 * raised, and there is no uniqueness constraint on `job_url` that would make it authoritative
 * anyway. **This resolves or it is a cancellation** — there is no failure mode for a caller to get
 * wrong, which is what makes "fails open" true of the code rather than true of one copy of it. The
 * extension's Application Pipeline and Log tab, and the dashboard's manual-entry flow, all call this
 * one function rather than each keeping its own `try`/`catch` around the lookup — the two that used
 * to had drifted into opposite policies (see `CONTEXT.md`'s Duplicate Guard entry).
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
