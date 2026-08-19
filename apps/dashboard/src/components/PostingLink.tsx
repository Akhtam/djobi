/**
 * The link out to a job posting, as a pill with an external-link icon.
 *
 * The URL is the `title`, not the text. Job-board URLs run long — a Workday or Greenhouse link with
 * a query string wraps to three lines — and the detail page used to render one in full, where it
 * pushed the record's own content down the page for no information a "Job posting" label doesn't
 * already give. The full URL stays reachable on hover and through the accessible name.
 *
 * `stretched` is for the list card, whose whole surface is covered by a stretched link to the detail
 * page (`.card__link::after`). This link has to be layered above it or the click is swallowed and
 * takes the reader to the detail page instead of the posting; `stopPropagation` isn't needed and
 * isn't used, since being on top is enough.
 */
export function PostingLink({
  jobUrl,
  company,
  stretched = false,
}: {
  jobUrl: string;
  /** Named in the accessible label, so a screen reader hears which posting a card links to. */
  company: string;
  stretched?: boolean;
}) {
  return (
    <a
      className={stretched ? 'posting-link posting-link--above-card' : 'posting-link'}
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
