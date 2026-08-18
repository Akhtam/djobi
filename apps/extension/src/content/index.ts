/**
 * Content script injected on every page (`manifest.ts` → `content_scripts`). Watches for the page
 * to become a job application form and keeps reporting it to the background service worker as it
 * changes (see `detect.ts`); answers `SCAN_PAGE` with a fresh scan on demand, and `FILL_FORM` by
 * filling the page.
 */
import type { ContentCommandMessage, JobPageData } from '../lib/messages';
import { detectFields } from './detectFields';
import { watchForJobApplicationPage } from './detect';
import { fillPage } from './fillForm';

/** Scans the live page into the shape the background stores and the Application Pipeline consumes. */
function scan(): JobPageData {
  return { fields: detectFields(document) };
}

/**
 * The last payload sent, so a re-scan triggered by an unrelated DOM change (a React re-render, the
 * candidate typing) doesn't re-send an identical report. Each report bumps the frame's revision in
 * `lib/tabStore.ts`, which invalidates any in-flight API-oracle enrichment for that frame — so
 * chattering here would keep cancelling the enrichment before it can ever land.
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
    chrome.runtime.sendMessage({ type: 'REPORT_JOB_PAGE', ...data });
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
 * Tears down the page watcher. A real content script never calls this — the page going away is what
 * ends it. Tests do: this module is a singleton over one shared jsdom `document`, so without it each
 * re-import leaves its observer and route poll running, and they go on reporting into the *next*
 * test's `chrome` stub.
 */
export function stopReporting(): void {
  stopWatching?.();
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
    void pending.then(sendResponse);

    return true; // keep the message channel open for the async sendResponse above
  },
);
