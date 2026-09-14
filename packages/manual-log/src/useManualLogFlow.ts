/**
 * The manual-log flow both surfaces render — the extension's Log tab
 * (`apps/extension/src/panel/LogApplication.tsx`) and the dashboard's "Log an application" modal
 * (`apps/dashboard/src/views/NewApplication.tsx`). Extract a pasted posting, let the candidate
 * review and correct its identity, then save a manual Application with their base profile resume.
 *
 * What stays with each app: every form field's state, the markup and chrome around a state, the
 * extension's "follow the active tab" prefill, and — the one genuinely different policy between the
 * two — what an error means. The dashboard treats a 401 as "redirect to sign-in"; the extension's
 * Log tab has no such policy today and shows every failure as a message in place. `ManualLogPorts`
 * takes that as an explicit `handleError` port rather than the hook guessing, so this stays a
 * controller over injected extraction/persistence/error behaviour — not a policy of its own.
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
 * What one extraction found, carried through every later state for it — `saving`/`save-error`
 * included, so a retry (calling `save` again from `save-error`) resends the same review rather than
 * losing it.
 */
export interface ManualLogReview {
  jobInfo: JobInfo;
  /** What the candidate already has on file for this posting, or `null` — the Duplicate Guard's hit. */
  duplicate: DuplicateApplication | null;
  /**
   * Generated once per successful extraction and reused for every save attempt of that same
   * review — never regenerated on a retry, only on a fresh `extract`. What makes a resend after a
   * timeout land the same row back instead of a second one; see each app's own save port.
   */
  idempotencyKey: string;
  /**
   * The URL and description `extract` actually sent to `extractJob`/the Duplicate Guard — trimmed
   * once, at the moment they were sent, and never re-read from a caller's live field state
   * afterwards. `save` builds its payload from this, not from whatever the caller's own inputs hold
   * by the time the candidate submits — closing the race where a value edited after extraction
   * started would otherwise reach the saved row without ever having been analyzed or
   * duplicate-checked.
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

/**
 * Just enough of a backend client to run this flow — so each app passes its own client (or a thin
 * adapter over it) rather than the hook naming a shape neither `BackendClient` nor `DashboardClient`
 * actually has.
 */
export interface ManualLogPorts extends DuplicateLookup {
  extractJob(jobDescription: string): Promise<JobInfo>;
  /**
   * Saves the manual Application, resolving to whether it landed. Never expected to throw for a
   * failure the candidate should see as `save-error` — a caller whose own client throws (the
   * extension's `saveApplication`) still may; `save` here catches that too, same as a `false`.
   */
  save(payload: NewApplicationRequest, idempotencyKey: string): Promise<boolean>;
  /**
   * What to do with a failure from `extractJob`, the Duplicate Guard, or `save` before it becomes an
   * `extract-error`/`save-error` message. Return `true` to suppress that transition — the caller is
   * already handling it itself (the dashboard redirects to sign-in on a 401 this way); return
   * `false` to let the flow show `userMessage(error)` as usual.
   */
  handleError(error: unknown, step: 'extract' | 'save'): boolean;
}

/** One message a generic failed save reports, for the one path that never throws — see `save` port. */
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
   * Extracts `jobDescription`/`jobUrl` and runs the Duplicate Guard alongside it, landing on
   * `extracted` (or `extract-error`, unless `ports.handleError` claimed it). Resolves with the
   * extracted `JobInfo` on success so a caller can prefill its own company/role fields, or `null`.
   *
   * Both requests go out together: the duplicate check doesn't depend on the extraction, and
   * serializing them would put a database round trip behind a model call for no reason. Sharing a
   * `Promise.all` with the extraction is only safe because `findDuplicate` resolves rather than
   * rejects (see `@djobi/shared`'s `duplicateGuard.ts`) — an inline `.catch` here would mean a
   * backend hiccup on a *warning* rejects the pair and discards a successful, already-paid
   * extraction over a failure in an advisory check that was never supposed to block anything.
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
   * Saves the current review as a manual Application under `profile`'s base resume, with the
   * candidate's possibly-corrected `company`/`roleTitle`. A no-op outside `extracted`/`save-error` —
   * there is nothing reviewed yet, or a save is already in flight.
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
   * Back to the empty form — "Edit posting"/"Back" from a review, and "Log another" after a save.
   * Clears nothing but the flow's own state: which form fields that leaves populated (and which a
   * caller resets around this call) is each app's own call — the extension keeps `jobUrl` following
   * the tracked tab, the dashboard doesn't.
   */
  function backToForm(): void {
    setState({ kind: 'form' });
  }

  return { state, extract, save, backToForm };
}
