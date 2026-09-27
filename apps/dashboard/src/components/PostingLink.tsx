import { isHttpUrl } from '@djobi/shared';

/**
 * The link out to a job posting, as a pill; the full URL is the `title` and accessible name, since
 * job-board URLs are long.
 *
 * A non-http(s) `jobUrl` renders as plain text: older rows predate `HttpUrlSchema`, and React will
 * render `href="javascript:…"` on the origin holding the session cookie.
 */
export function PostingLink({
  jobUrl,
  company,
}: {
  jobUrl: string;
  /** Named in the accessible label, so a screen reader hears which posting the link opens. */
  company: string;
}) {
  if (!isHttpUrl(jobUrl)) {
    return (
      <span className="posting-link posting-link--unsafe" title={jobUrl}>
        Job posting unavailable
      </span>
    );
  }

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
