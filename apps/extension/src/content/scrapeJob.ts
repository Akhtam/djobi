/**
 * Extracts the job posting's readable text for `/extract-job`, stripped of nav/footer chrome via
 * a simple readability heuristic: `<main>` first, then `[role="main"]`, falling back to the full
 * `document.body` text when neither landmark exists.
 */
export function scrapePageText(doc: Document): string {
  const container = doc.querySelector('main') ?? doc.querySelector('[role="main"]') ?? doc.body;
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}
