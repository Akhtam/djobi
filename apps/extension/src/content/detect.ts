import { getSignal } from './pageSignals';

/**
 * Labels only an application form has (resume, CV, cover letter, LinkedIn). Matched against a
 * control's own label, never page prose — a posting *describes* the resume it wants.
 */
const APPLICATION_FIELD_SIGNAL = /re[sz]ume|\bcv\b|cover letter|linkedin/i;

/**
 * Heuristic: is this page an actual job application form? No `<form>` ancestor is required
 * (embedded ATS widgets often lack one). A resume file input is the cheap, strong signal; a control
 * labelled as an application-only field also counts, since some ATSes create the file input only on
 * click.
 */
export function isJobApplicationPage(doc: Document): boolean {
  if (doc.querySelector('input[type="file"]') !== null) return true;

  return Array.from(doc.querySelectorAll('input, textarea')).some((el) =>
    APPLICATION_FIELD_SIGNAL.test(getSignal(doc, el)),
  );
}

export interface WatchOptions {
  /**
   * How long one arming window waits for the page to become a job application page. Default 10s.
   */
  timeoutMs?: number;
  /**
   * Quiet period after a DOM change before re-reporting, once the page has qualified. Default
   * 500ms.
   */
  settleMs?: number;
  /** How often to check for a client-side route change. Default 1s. */
  urlPollMs?: number;
}

/**
 * Calls `onDetected` once the page qualifies, then again (debounced by `settleMs`) on every DOM
 * change, so callers always have a current picture of the form. Handles:
 *
 * 1. **Late-mounting forms** — a MutationObserver during the arming window.
 * 2. **Partial mounts** — re-reporting on every settled change, not just the first hit.
 * 3. **Client-side routes** (Ashby's `pushState` to `/application`) — a URL poll re-arms on any
 *    `location.href` change (a content script can't patch the page's own `pushState`).
 *
 * The arming window gives up quietly on non-qualifying pages, since this runs on every page.
 * Returns `stop()`, which cancels everything.
 */
export function watchForJobApplicationPage(
  doc: Document,
  onDetected: () => void,
  { timeoutMs = 10_000, settleMs = 500, urlPollMs = 1_000 }: WatchOptions = {},
): () => void {
  let observer: MutationObserver | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let settleId: ReturnType<typeof setTimeout> | undefined;

  function disarm(): void {
    observer?.disconnect();
    observer = null;
    clearTimeout(timeoutId);
    clearTimeout(settleId);
  }

  /**
   * Re-reports once the DOM has been quiet for `settleMs` — a React re-render is many mutations.
   */
  function reportWhenSettled(): void {
    clearTimeout(settleId);
    settleId = setTimeout(() => {
      if (isJobApplicationPage(doc)) onDetected();
    }, settleMs);
  }

  /**
   * Switches from "waiting for a form" to "watching the form we found" — no timeout from here on.
   */
  function watchQualifiedPage(): void {
    clearTimeout(timeoutId);
    observer?.disconnect();
    // Deliberately `childList` only: `detectFields` tags elements with `data-djobi-id` as it scans,
    // and observing attributes would make every scan schedule the next one, forever.
    observer = new MutationObserver(reportWhenSettled);
    observer.observe(doc.body, { childList: true, subtree: true });
    onDetected();
  }

  function arm(): void {
    disarm();

    if (isJobApplicationPage(doc)) {
      watchQualifiedPage();
      return;
    }

    observer = new MutationObserver(() => {
      if (isJobApplicationPage(doc)) watchQualifiedPage();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    timeoutId = setTimeout(disarm, timeoutMs);
  }

  let lastHref = doc.location.href;
  const urlPollId = setInterval(() => {
    if (doc.location.href === lastHref) return;
    lastHref = doc.location.href;
    arm();
  }, urlPollMs);

  arm();

  return () => {
    clearInterval(urlPollId);
    disarm();
  };
}
