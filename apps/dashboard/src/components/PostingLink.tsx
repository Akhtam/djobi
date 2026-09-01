/**
 * The link out to a job posting, as a pill with an external-link icon.
 *
 * The URL is the `title`, not the text. Job-board URLs run long — a Workday or Greenhouse link with
 * a query string wraps to three lines — and the detail page used to render one in full, where it
 * pushed the record's own content down the page for no information a "Job posting" label doesn't
 * already give. The full URL stays reachable on hover and through the accessible name.
 *
 * The visible label stays present in both the applications table and detail view; the full URL is
 * available from the title and accessible name without consuming a table column.
 */
export function PostingLink({
  jobUrl,
  company,
}: {
  jobUrl: string;
  /** Named in the accessible label, so a screen reader hears which posting the link opens. */
  company: string;
}) {
  return (
    <a
      className="posting-link"
      href={jobUrl}
      target="_blank"
      rel="noreferrer"
      title={jobUrl}
      aria-label={`Open the ${company} job posting in a new tab`}
    >
      Job posting
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    </a>
  );
}
