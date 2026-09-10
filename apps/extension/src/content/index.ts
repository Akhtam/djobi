/**
 * Content script injected on every page (`manifest.ts` → `content_scripts`). Watches for the page
 * to become a job application form and keeps reporting it to the background service worker as it
 * changes (see `detect.ts`); answers `SCRAPE_JOB_DESCRIPTION` with focused posting text,
 * `SCAN_PAGE` with a fresh form scan, and `FILL_FORM` by filling the page.
 */
import { notify, type ContentCommandMessage, type JobPageData } from '../lib/messages';
import { detectFields } from './detectFields';
import { watchForJobApplicationPage } from './detect';
import { fillPage } from './fillForm';
import { armSubmitWatch } from './submitWatch';
import { showSavedToast } from './savedToast';
import { extractJobDescriptionWhenReady } from './extractJobDescription';

/** Scans the live page into the shape the background stores and the Application Pipeline consumes. */
function scan(): JobPageData {
  return { fields: detectFields(document) };
}

/**
 * The last payload sent, so a re-scan triggered by an unrelated DOM change (a React re-render, the
 * candidate typing) doesn't re-send an identical report. Each report bumps the frame's revision in
 * `lib/tabStore/detectedPage.ts`, which invalidates any in-flight API-oracle enrichment for that
 * frame — so chattering here would keep cancelling the enrichment before it can ever land.
 */
let lastReported: string | null = null;

/**
 * Reports a scan, unless it's identical to the last one.
 *
 * `chrome.runtime.sendMessage` throws `Extension context invalidated` from a content script left
 * behind by a reloaded extension — the everyday state of a tab that was open across a rebuild. That
 * used to be swallowed silently: the page looked detected, nothing was ever reported, and the panel
 * offered to analyze a form it would then fill nothing into. Now the orphan stops watching and says
 * why, once.
 */
let orphaned = false;
/** Assigned once `watchForJobApplicationPage` returns — which is *after* its first synchronous report. */
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
    // The `orphaned` flag, rather than `stopWatching()` alone: a page that already qualified is
    // reported synchronously from inside `watchForJobApplicationPage`, before it has returned the
    // stop function there'd be to call.
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
 * Cancels the previous fill's submission watcher, if any. A re-fill of the same page re-arms rather
 * than adding a second listener pair, and a fill for a *new* run must not leave a watcher behind
 * that would report the old run's id.
 */
let stopSubmitWatch: (() => void) | null = null;

/**
 * Tears down the page watcher. A real content script never calls this — the page going away is what
 * ends it. Tests do: this module is a singleton over one shared jsdom `document`, so without it each
 * re-import leaves its observer and route poll running, and they go on reporting into the *next*
 * test's `chrome` stub.
 */
export function stopReporting(): void {
  stopWatching?.();
  stopSubmitWatch?.();
  stopSubmitWatch = null;
}

/**
 * Watches for the candidate submitting the form we just filled, and reports it once.
 *
 * Reporting is fire-and-forget by design: a submission normally navigates the page, so this content
 * script is being torn down as the message goes out. The service worker owns the Save Step from
 * there — see `background/applicationPipeline.ts`, where the Save Step is deliberately
 * `cancellation: 'none'` for this same reason.
 */
function watchForSubmission(runId: string): void {
  stopSubmitWatch?.();
  stopSubmitWatch = armSubmitWatch(document, () => {
    stopSubmitWatch = null;
    try {
      notify({ type: 'REPORT_SUBMISSION', runId });
    } catch {
      // An orphaned content script (extension reloaded since the fill) has nobody to tell. There is
      // nothing to retry and nothing the candidate can do about it from here, so it stays quiet —
      // `report()` above already warns once about this tab being orphaned.
    }
  });
}

chrome.runtime.onMessage.addListener(
  (message: ContentCommandMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (message.type === 'SCAN_PAGE') {
      // Deliberately *not* gated on `isJobApplicationPage`. That heuristic exists to decide whether
      // to volunteer an unasked-for detection on one of the many pages this script runs on, and
      // being wrong there costs nothing. A scan is the opposite situation: the user has picked this
      // tab and clicked Fill, so the only question worth asking is whether there are fields here.
      // Gating it on the heuristic made the heuristic a single point of failure for filling too —
      // a form it doesn't recognize couldn't be detected *or* filled.
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
