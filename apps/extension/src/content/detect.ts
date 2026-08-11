/**
 * Heuristic: is this page an actual job application form, not a marketing/listing/login page or
 * an unrelated site? A resume file upload input is the strongest signal — no `<form>` ancestor is
 * required, since embedded ATS widgets (e.g. Ashby's embed script rendering into a plain
 * `<div id="ashby_embed">` on a company's own domain) often don't use a native `<form>` element.
 */
export function isJobApplicationPage(doc: Document): boolean {
  return doc.querySelector('input[type="file"]') !== null;
}

export interface WatchOptions {
  /** How long to keep watching for the page to become a job application page. Default 10s. */
  timeoutMs?: number;
}

/**
 * Calls `onDetected` once `isJobApplicationPage(doc)` becomes true — immediately (synchronously)
 * if already true, or by observing DOM mutations for up to `timeoutMs` otherwise. This matters
 * because the content script now runs on every page (not just a fixed ATS-domain allowlist), and
 * some ATS embed widgets (e.g. Ashby's on a customer's own careers page) render their form into
 * the page asynchronously, well after `document_idle` — a one-shot check at load would miss them.
 * Gives up quietly (never calls `onDetected`) if nothing appears within the timeout, so the
 * observer doesn't run indefinitely on the vast majority of pages that are never job postings.
 * Returns a `stop()` function to cancel watching early.
 */
export function watchForJobApplicationPage(
  doc: Document,
  onDetected: () => void,
  { timeoutMs = 10_000 }: WatchOptions = {},
): () => void {
  if (isJobApplicationPage(doc)) {
    onDetected();
    return () => {};
  }

  const observer = new MutationObserver(() => {
    if (isJobApplicationPage(doc)) {
      stop();
      onDetected();
    }
  });

  const timeoutId = setTimeout(() => stop(), timeoutMs);

  function stop() {
    observer.disconnect();
    clearTimeout(timeoutId);
  }

  observer.observe(doc.body, { childList: true, subtree: true });

  return stop;
}
