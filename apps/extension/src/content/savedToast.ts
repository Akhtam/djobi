/**
 * The on-page confirmation that an auto-saved application was recorded.
 *
 * Shown because the surface that already reports a save — the side panel's `saved` status — is
 * closed in the case this exists for. The candidate pressed the ATS's own Submit button; the panel
 * was never open, and the tab is on its way to a confirmation page. So the confirmation has to be
 * where they are looking.
 *
 * Rendered into a **closed shadow root**: an ATS page's CSS is arbitrary, and a bare `<div>` on
 * Workday inherits enough of it to come out invisible or full-width. The shadow boundary also keeps
 * this out of the page's own selectors, which matters because the page is mid-submission and its
 * scripts are still running.
 */

/** How long the toast stays up. Long enough to read a company and a role, short enough to ignore. */
const VISIBLE_MS = 5_000;

const HOST_ID = 'djobi-saved-toast';

const STYLES = `
  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    max-width: 320px;
    padding: 12px 16px;
    border-radius: 10px;
    background: #10281c;
    color: #eafaf1;
    border: 1px solid #2f7d5a;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  .title { display: flex; align-items: center; gap: 8px; }
  .check { color: #55d99a; font-size: 15px; }
  .job { margin-top: 4px; color: #b9d8c9; font-weight: 400; }
`;

/**
 * Shows "Saved to djobi" for `company` / `roleTitle`, replacing any toast already up.
 *
 * Replacing rather than stacking: a re-save of the same run is one fact being restated, and two
 * toasts overlapping in the corner of an ATS form is worse than none.
 */
export function showSavedToast(
  doc: Document,
  { company, roleTitle }: { company: string; roleTitle: string },
): void {
  if (!doc.body) return;

  doc.getElementById(HOST_ID)?.remove();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = STYLES;

  const toast = doc.createElement('div');
  toast.className = 'toast';

  const title = doc.createElement('div');
  title.className = 'title';
  const check = doc.createElement('span');
  check.className = 'check';
  check.textContent = '✓';
  const label = doc.createElement('span');
  label.textContent = 'Application saved to djobi';
  title.append(check, label);

  const job = doc.createElement('div');
  job.className = 'job';
  // `textContent`, never `innerHTML`: company and role come back from an LLM extraction of a page
  // this extension does not control, and are written into that same page.
  job.textContent = [company, roleTitle].filter((part) => part.trim()).join(' — ');

  toast.append(title);
  if (job.textContent) toast.append(job);
  root.append(style, toast);
  doc.body.append(host);

  setTimeout(() => host.remove(), VISIBLE_MS);
}
