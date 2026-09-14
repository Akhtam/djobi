/**
 * The words for one Run Notice.
 *
 * `reviewOf` (`lib/run/review.ts`) says which situation a run is in; this says the sentence. That
 * split is deliberate and predates this module — what changed is where the sentence lives. It used
 * to sit inside `AutofillTab.tsx` alongside detection state, the resume preview lifecycle and the
 * whole render tree, which meant the only way to reach one line of copy was to drive an entire
 * Application Pipeline run to the outcome that produces it. The wording is a product judgement —
 * "reload the page" versus "fill it in by hand" sends the candidate after two different problems —
 * and judgement worth arguing about deserves a seam you can render directly.
 *
 * The interface is the whole notice and one callback: the tab still owns *whether* a retry is
 * eligible and what it does, this owns only how the situation reads and which action it offers.
 * The `switch` stays exhaustive over `RunNotice['kind']`, so a notice added to `reviewOf` fails to
 * compile until it has copy here.
 */
import { formatAppliedDate, formatStage } from '../lib/format';
import type { RunFailureKind, RunNotice, RunNoticeAction, RunStep } from '../lib/run';

function assertNever(value: never): never {
  throw new Error(`Unhandled run notice: ${JSON.stringify(value)}`);
}

/**
 * Why a step failed, in the candidate's terms. `step` matters because the same underlying failure
 * calls for different advice depending on what may have half-happened: a `temporary` failure during
 * Fill may have written to the page, and during Save may have already recorded the Application.
 */
function failureReason(kind: RunFailureKind, step: RunStep): string {
  switch (kind) {
    case 'temporary':
      if (step === 'fill') {
        return 'The form may have been partially filled. Check the application page before trying again.';
      }
      if (step === 'save') {
        return 'The save may have gone through. Check the dashboard before trying again.';
      }
      return "djobi couldn't finish that just now. Try again in a moment.";
    case 'backend-unreachable':
      return "djobi couldn't reach its backend. Check that it's running, then try again.";
    case 'invalid-page':
      return "This page sent back something djobi couldn't read. Reload it, then try again.";
    case 'invalid-model-output':
      return "The AI came back with something djobi couldn't use. Try again.";
    case 'unauthorized':
      return "You've been signed out. Sign in again from the extension options, then retry.";
    case 'cancelled':
      return 'This attempt was cancelled.';
    case 'unknown':
      return 'Something unexpected went wrong. Try again.';
  }
}

export function RunNoticeView({
  notice,
  onAction,
}: {
  notice: RunNotice;
  onAction: (action: RunNoticeAction) => void;
}) {
  switch (notice.kind) {
    case 'duplicate':
      return (
        <div className="state" role="status">
          <span className="state-icon">📮</span>
          <p>
            {notice.duplicate.count > 1
              ? `You've already applied to this job ${notice.duplicate.count} times, most recently on ${formatAppliedDate(notice.duplicate.createdAt)}.`
              : `You already applied to this job on ${formatAppliedDate(notice.duplicate.createdAt)}.`}
          </p>
          <p className="failure-detail">
            {notice.duplicate.roleTitle} at {notice.duplicate.company} ·{' '}
            {formatStage(notice.duplicate.stage)}
          </p>
          <button type="button" className="btn-primary" onClick={() => onAction(notice.action)}>
            Analyze and apply anyway
          </button>
        </div>
      );

    case 'analyze-failed':
      return (
        <div className="state error" role="alert">
          <span className="state-icon error">⚠️</span>
          <p>Something went wrong analyzing this job posting.</p>
          <p>{failureReason(notice.reason, 'analysis')}</p>
          <button type="button" className="btn-secondary" onClick={() => onAction(notice.action)}>
            Try again
          </button>
        </div>
      );

    case 'fill-unverified':
      return (
        <div className="state error" role="alert">
          <span className="state-icon error">⚠️</span>
          <p>
            This page didn't answer, so djobi can't confirm what was filled. Check the form before
            you submit or save. If fields are still empty, reload the page and try again.
          </p>
        </div>
      );

    case 'no-fields-detected':
      return (
        <div className="state error" role="alert">
          <span className="state-icon error">⚠️</span>
          <p>
            Nothing was filled — djobi found no form fields on this page, even after rescanning just
            now. You'll have to fill the form yourself before saving. If the form is clearly there,
            reload the page and try again: djobi can't reach a page that was already open the last
            time the extension reloaded.
          </p>
        </div>
      );

    // The other zero-filled outcome, and a different problem: the form was read fine and then
    // kept none of what was written into it. Reloading is not the advice here — the list of
    // fields to fill by hand is.
    case 'nothing-filled':
      return (
        <div className="state error" role="alert">
          <span className="state-icon error">⚠️</span>
          <p>
            Nothing was filled — this page's form was found ({notice.detectedFieldCount} field
            {notice.detectedFieldCount === 1 ? '' : 's'}), but it kept none of the values written
            into it. You'll need to fill it in yourself before saving this application.
          </p>
        </div>
      );

    case 'fill-complete':
      return (
        <div className="state success compact" role="status">
          <span className="state-icon success">✅</span>
          <p>
            Filled {notice.filledFieldCount} field{notice.filledFieldCount === 1 ? '' : 's'}. Save
            the application when you're ready.
          </p>
        </div>
      );

    case 'fill-incomplete':
      return (
        <div className="state error" role="alert">
          <span className="state-icon error">⚠️</span>
          <p>
            Filled, but {notice.unresolvedRequiredFields.length} required field
            {notice.unresolvedRequiredFields.length === 1 ? '' : 's'} didn't take a value — fill{' '}
            {notice.unresolvedRequiredFields.length === 1 ? 'it' : 'them'} in by hand before
            submitting:
          </p>
          <ul className="unresolved-fields">
            {notice.unresolvedRequiredFields.map((field) => (
              <li key={field.id}>{field.label || field.category}</li>
            ))}
          </ul>
        </div>
      );

    case 'saved':
      return (
        <div className="state success compact" role="status">
          <span className="state-icon success">✅</span>
          <p>Application saved.</p>
        </div>
      );

    case 'fill-failed':
    case 'save-failed':
      return (
        <div className="inline-error" role="alert">
          <div className="inline-error-body">
            <p>
              {notice.kind === 'fill-failed'
                ? 'Something went wrong filling the form.'
                : 'Something went wrong saving the application.'}
            </p>
            <p>{failureReason(notice.reason, notice.kind === 'fill-failed' ? 'fill' : 'save')}</p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => onAction(notice.action)}>
            Try again
          </button>
        </div>
      );
  }
  return assertNever(notice);
}
