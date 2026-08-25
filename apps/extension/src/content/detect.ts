import { getSignal } from './pageSignals';

/**
 * A field label that only appears on a job application: the things a candidate is asked to hand
 * over. Matched against a form control's *own* label, never the page's prose — a job posting
 * describes the resume it wants, and only the application form has a field asking for one.
 */
const APPLICATION_FIELD_SIGNAL = /re[sz]ume|\bcv\b|cover letter|linkedin/i;

/**
 * Heuristic: is this page an actual job application form, not a marketing/listing/login page or
 * an unrelated site? No `<form>` ancestor is required, since embedded ATS widgets (e.g. Ashby's
 * embed script rendering into a plain `<div id="ashby_embed">` on a company's own domain) often
 * don't use a native `<form>` element.
 *
 * A resume file upload input is the strongest signal, and the cheap one, so it's checked first. It
 * is not sufficient on its own, though: an ATS can render its upload control as a button that only
 * creates an `<input type="file">` once clicked, or drive it through the File System Access API
 * with no input element at all — and a form like that was previously invisible to this extension no
 * matter how many ordinary fields it had. So a control *labelled* as one of the things only a job
 * application asks for counts too.
 */
export function isJobApplicationPage(doc: Document): boolean {
  if (doc.querySelector('input[type="file"]') !== null) return true;

  return Array.from(doc.querySelectorAll('input, textarea')).some((el) =>
    APPLICATION_FIELD_SIGNAL.test(getSignal(doc, el)),
  );
}

export interface WatchOptions {
  /** How long one arming window waits for the page to become a job application page. Default 10s. */
  timeoutMs?: number;
  /** Quiet period after a DOM change before re-reporting, once the page has qualified. Default 500ms. */
  settleMs?: number;
  /** How often to check for a client-side route change. Default 1s. */
  urlPollMs?: number;
}

/**
 * Calls `onDetected` once `isJobApplicationPage(doc)` becomes true, and **again** — debounced by
 * `settleMs` — every time the DOM subsequently changes, so a caller always has a current picture of
 * the form rather than a snapshot of whatever happened to be mounted at the first qualifying instant.
 *
 * Three things this has to survive, all of which used to leave a tab permanently undetected because
 * detection was one-shot and gave up after a fixed window:
 *
 * 1. **Late-mounting forms.** An ATS embed widget renders its form well after `document_idle`, so a
 *    check at load misses it. Hence the arming window's MutationObserver.
 * 2. **Partial mounts.** A form's file input can appear a frame or two before the rest of its
 *    fields. Firing once at that instant reports a form with almost nothing in it — and nothing ever
 *    corrects it. Hence re-reporting on every settled change rather than stopping at the first hit.
 * 3. **Client-side routes.** Ashby's posting page and its `/application` form are one document; the
 *    "Apply" click is a `pushState`, so no new content script runs. If the arming window had already
 *    elapsed, the form was never seen. Hence the URL poll, which re-arms on any `location.href`
 *    change. (Polling, not a `history.pushState` patch: a content script's patch lands in its
 *    isolated world and never sees the page's own calls.)
 *
 * The arming window still exists, and still gives up quietly, because this content script runs on
 * *every* page: an observer left connected indefinitely on the vast majority of pages that are not
 * job postings is a cost paid for nothing. Once a page qualifies it is a job application page, and
 * the observer stays connected for as long as it remains one.
 *
 * Returns a `stop()` function that cancels everything, including the URL poll.
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

  /** Re-reports once the DOM has been quiet for `settleMs` — a React re-render is many mutations. */
  function reportWhenSettled(): void {
    clearTimeout(settleId);
    settleId = setTimeout(() => {
      if (isJobApplicationPage(doc)) onDetected();
    }, settleMs);
  }

  /** Switches from "waiting for a form" to "watching the form we found" — no timeout from here on. */
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
