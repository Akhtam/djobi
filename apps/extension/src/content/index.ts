/**
 * Content script on every page. Watches for a job application form and reports it as it changes
 * (`detect.ts`); answers `SCRAPE_JOB_DESCRIPTION`, `SCAN_PAGE` and `FILL_FORM`; shows the saved
 * toast; and, after a fill, watches for the candidate's own submit.
 */
import { notify, type ContentCommandMessage, type JobPageData } from '../lib/messages';
import { detectFields } from './detectFields';
import { watchForJobApplicationPage } from './detect';
import { fillPage } from './fillForm';
import { armSubmitWatch } from './submitWatch';
import { showSavedToast } from './savedToast';
import { extractJobDescriptionWhenReady } from './extractJobDescription';

/**
 * Scans the live page into the shape the background stores and the Application Pipeline consumes.
 */
function scan(): JobPageData {
  return { fields: detectFields(document) };
}

/**
 * The last payload sent, so unrelated DOM changes don't re-send an identical report — each report
 * bumps the frame's revision and would cancel in-flight API enrichment.
 */
let lastReported: string | null = null;

/**
 * Set once this content script is orphaned by an extension reload (`sendMessage` throws "Extension
 * context invalidated"); it then stops watching and warns once.
 */
let orphaned = false;
/**
 * Assigned once `watchForJobApplicationPage` returns — which is *after* its first synchronous
 * report.
 */
let stopWatching: (() => void) | null = null;

function report(): void {
  if (orphaned) return;

  const data = scan();
  const payload = JSON.stringify(data);
  if (payload === lastReported) return;

  try {
    notify({ type: 'REPORT_JOB_PAGE', ...data });
    lastReported = payload;
  } catch (error) {
    // A flag, not just `stopWatching()`: the first report can fire before the stop function exists.
    orphaned = true;
    stopWatching?.();
    console.warn(
      '[djobi] stopped watching this page — the extension was reloaded, so this content script is orphaned. Reload the page to reconnect.',
      error,
    );
  }
}

stopWatching = watchForJobApplicationPage(document, report);
if (orphaned) stopWatching();

/**
 * The previous fill's submission watcher. A re-fill re-arms it, and a new run must not leave one
 * reporting the old run's id.
 */
let stopSubmitWatch: (() => void) | null = null;

/**
 * Tears down the page watcher — for tests, since this module is a singleton over a shared jsdom
 * `document`.
 */
export function stopReporting(): void {
  stopWatching?.();
  stopSubmitWatch?.();
  stopSubmitWatch = null;
}

/**
 * Watches for the candidate submitting the form we filled and reports it once, fire-and-forget (the
 * submit usually navigates away). The worker's Save Step is `cancellation: 'none'` for the same
 * reason.
 */
function watchForSubmission(runId: string): void {
  stopSubmitWatch?.();
  stopSubmitWatch = armSubmitWatch(document, () => {
    stopSubmitWatch = null;
    try {
      notify({ type: 'REPORT_SUBMISSION', runId });
    } catch {
      // Orphaned: nobody to tell, and `report()` already warned once.
    }
  });
}

chrome.runtime.onMessage.addListener(
  (message: ContentCommandMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (message.type === 'SCAN_PAGE') {
      // Not gated on `isJobApplicationPage`: the user asked to fill this tab, so the only question
      // is whether there are fields here.
      const data = scan();
      // Frames with no fields stay silent, so the reply comes from the frame holding the form.
      if (data.fields.length === 0) return false;
      sendResponse(data);
      return false;
    }

    if (message.type === 'SCRAPE_JOB_DESCRIPTION') {
      void extractJobDescriptionWhenReady(document).then((candidate) =>
        sendResponse({ candidate }),
      );
      return true;
    }

    if (message.type === 'SHOW_SAVED_TOAST') {
      showSavedToast(document, { company: message.company, roleTitle: message.roleTitle });
      return false;
    }

    if (message.type !== 'FILL_FORM') return false;

    const resumeFile = message.resumeFile
      ? new File([new Uint8Array(message.resumeFile.bytes)], message.resumeFile.name, {
          type: message.resumeFile.type,
        })
      : undefined;
    const pending = fillPage(document, message.fields, message.values, resumeFile);

    // A non-owner must decline synchronously. Sending `null` or holding its channel open would let
    // an empty third-party frame beat the real form's asynchronous verified response.
    if (pending === null) return false;
    const { runId } = message;
    void pending.then((result) => {
      // Armed from the fill's own result, in the frame that owns the form: this frame filled it, so
      // this frame is the one whose submission means the run went out.
      watchForSubmission(runId);
      sendResponse(result);
    });

    return true; // keep the message channel open for the async sendResponse above
  },
);
