/**
 * The manual-log flow behind the extension's Log tab and the dashboard's "Log an application":
 * extract a pasted posting, let the candidate review company/role, then save a manual Application
 * with their Base Resume.
 *
 * Each app keeps its form state, markup, the extension's follow-the-active-tab prefill, and its
 * error policy, injected as `handleError` (the dashboard redirects on 401; the extension shows it).
 */
import { useState } from 'react';
import { userMessage } from '@djobi/http-client';
import {
  findDuplicate,
  manualApplicationPayload,
  type DuplicateApplication,
  type DuplicateLookup,
  type JobInfo,
  type NewApplicationRequest,
  type Profile,
} from '@djobi/shared';

/**
 * What one extraction found, carried through `saving`/`save-error` so a retry resends the same
 * review.
 */
export interface ManualLogReview {
  jobInfo: JobInfo;
  /**
   * What the candidate already has on file for this posting, or `null` — the Duplicate Guard's hit.
   */
  duplicate: DuplicateApplication | null;
  /**
   * Generated per successful extraction and reused on every save retry, so a resend after a
   * timeout updates the same row.
   */
  idempotencyKey: string;
  /**
   * The trimmed URL and description `extract` actually sent. `save` uses these, not live field
   * state, so nothing unanalyzed or un-duplicate-checked reaches the saved row.
   */
  source: { jobUrl: string; jobDescription: string };
}

export type ManualLogState =
  | { kind: 'form' }
  | { kind: 'extracting' }
  | { kind: 'extract-error'; message: string }
  | ({ kind: 'extracted' } & ManualLogReview)
  | ({ kind: 'saving' } & ManualLogReview)
  | ({ kind: 'save-error'; message: string } & ManualLogReview)
  | { kind: 'saved'; company: string; roleTitle: string };

/** The backend methods this flow needs; each app passes its client or a thin adapter. */
export interface ManualLogPorts extends DuplicateLookup {
  extractJob(jobDescription: string): Promise<JobInfo>;
  /**
   * Saves the manual Application, resolving to whether it landed. A throw is treated like `false`.
   */
  save(payload: NewApplicationRequest, idempotencyKey: string): Promise<boolean>;
  /**
   * Called on an `extract`/`save` failure. Return `true` if the caller handled it (e.g. dashboard
   * sign-in redirect on 401) to skip the error state; `false` to show `userMessage(error)`.
   */
  handleError(error: unknown, step: 'extract' | 'save'): boolean;
}

/**
 * One message a generic failed save reports, for the one path that never throws — see `save` port.
 */
const SAVE_FAILED_MESSAGE = 'Something went wrong logging the application.';

/** What {@link useManualLogFlow} hands its caller. */
export interface ManualLogFlow {
  state: ManualLogState;
  extract: (jobUrl: string, jobDescription: string) => Promise<JobInfo | null>;
  save: (profile: Profile, company: string, roleTitle: string) => Promise<void>;
  backToForm: () => void;
}

export function useManualLogFlow(ports: ManualLogPorts): ManualLogFlow {
  const [state, setState] = useState<ManualLogState>({ kind: 'form' });

  /**
   * Extracts Job Info and runs the Duplicate Guard in parallel, landing on `extracted` or
   * `extract-error`. Resolves with the `JobInfo` (for prefilling) or `null`. Safe in one
   * `Promise.all` because `findDuplicate` never rejects on lookup failure.
   */
  async function extract(jobUrl: string, jobDescription: string): Promise<JobInfo | null> {
    // Trimmed once, here — see `ManualLogReview.source`'s own doc for why this is never re-read
    // from the caller's live fields again.
    const source = { jobUrl: jobUrl.trim(), jobDescription: jobDescription.trim() };
    setState({ kind: 'extracting' });
    try {
      const [jobInfo, duplicate] = await Promise.all([
        ports.extractJob(source.jobDescription),
        findDuplicate(ports, source.jobUrl),
      ]);
      setState({
        kind: 'extracted',
        jobInfo,
        duplicate,
        idempotencyKey: crypto.randomUUID(),
        source,
      });
      return jobInfo;
    } catch (error) {
      if (!ports.handleError(error, 'extract')) {
        setState({ kind: 'extract-error', message: userMessage(error) });
      }
      return null;
    }
  }

  /**
   * Saves the review as a manual Application with the candidate's `company`/`roleTitle`. No-op
   * outside `extracted`/`save-error`.
   */
  async function save(profile: Profile, company: string, roleTitle: string): Promise<void> {
    if (state.kind !== 'extracted' && state.kind !== 'save-error') return;
    const review = state;
    // Spread first: a trailing `...review` would put its old `kind` back and the state would never
    // leave `extracted`/`save-error`.
    setState({ ...review, kind: 'saving' });

    const payload: NewApplicationRequest = manualApplicationPayload(profile, {
      jobUrl: review.source.jobUrl,
      jobDescription: review.source.jobDescription,
      jobInfo: review.jobInfo,
      company,
      roleTitle,
    });

    try {
      const landed = await ports.save(payload, review.idempotencyKey);
      if (landed) {
        setState({ kind: 'saved', company: company.trim(), roleTitle: roleTitle.trim() });
      } else if (!ports.handleError(new Error(SAVE_FAILED_MESSAGE), 'save')) {
        setState({ ...review, kind: 'save-error', message: SAVE_FAILED_MESSAGE });
      }
    } catch (error) {
      if (!ports.handleError(error, 'save')) {
        setState({ ...review, kind: 'save-error', message: userMessage(error) });
      }
    }
  }

  /**
   * Back to the empty form ("Edit posting", "Back", "Log another"). Resets only flow state; each
   * app decides which form fields to clear.
   */
  function backToForm(): void {
    setState({ kind: 'form' });
  }

  return { state, extract, save, backToForm };
}
