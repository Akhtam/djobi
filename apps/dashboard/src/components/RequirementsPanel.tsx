/**
 * The Analytics view's requirements panel: every posting's requirement text, grouped by posting,
 * newest first — the half of `JobInfo.requirements` that cannot be aggregated (see
 * `PROGRESS.md`'s Phase 12 section). Whole sentences don't repeat across postings, so this stays a
 * readable list rather than a table of ones that would look like analysis and isn't.
 *
 * Owns its whole panel — head, required/preferred/years roll-up, and the scroll region — rather
 * than splitting the head into `Analytics.tsx`, because the head's subtitle ("N of M postings")
 * and title ("Requirements mentioning React") are both derived from state only this component
 * holds (the revealed count, the keyword match). Threading them back up as props would just be
 * this component's own derived state, relayed through a parent that has no other use for it.
 *
 * Its own scroll region, not the page's: a busy 60-day range can hold 100-200 postings, and a
 * full-height panel would swallow the page's own scroll. Revealing more as the reader approaches
 * the end is `useRevealOnScroll`'s job; this component owns only what to show and how to filter it.
 */
import { type ReactNode } from 'react';
import { normalizeLabel, type Application } from '@djobi/shared';
import { requirementKindCounts, yearsOfExperienceDistribution } from '../lib/analytics';
import { applicationPath, PAGE_SIZE } from '../lib/useHashRoute';
import { useRevealOnScroll } from '../lib/useRevealOnScroll';
import { formatDate } from '../lib/format';

/**
 * Splits `text` on a case-insensitive match of `term`, wrapping each match in `<mark>`. Built with
 * `String.split` against a capturing regex rather than an HTML string and `dangerouslySetInnerHTML`
 * — the posting text is real data, and a term containing HTML-significant characters must not be
 * able to inject markup into the page.
 */
function highlightTerm(text: string, term: string | null): ReactNode {
  if (!term) return text;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'i'));
  if (parts.length === 1) return text;
  // `String.split` against a one-group capturing regex alternates non-match/match/non-match/…
  // regardless of content, so the odd indices are exactly the substrings that matched.
  return parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

export function RequirementsPanel({
  applications,
  selectedKeyword,
  resetKey,
}: {
  /**
   * Already scoped to the selected range and stage — this component filters only by keyword.
   * Always non-empty: `Analytics` renders its own empty state instead of this component when its
   * range/stage filter matches nothing.
   */
  applications: Application[];
  /**
   * The term selected from the keyword frequency table, or `null` for every posting in range.
   * Matched via `normalizeLabel` — the same grouping the frequency table itself uses — so selecting
   * the displayed spelling still finds postings that used a different-cased variant. Also the term
   * highlighted inside each shown requirement's text.
   */
  selectedKeyword: string | null;
  /**
   * Changes whenever the range, stage or keyword selection does, so a previously revealed batch
   * cannot outlive the result set it was revealed for. Owned by the caller because it alone knows
   * the range and stage this component's already-filtered `applications` came from.
   */
  resetKey: string;
}) {
  const needle = selectedKeyword ? normalizeLabel(selectedKeyword) : null;
  const matching = needle
    ? applications.filter((application) =>
        application.jobInfo.keywords.some((keyword) => normalizeLabel(keyword.term) === needle),
      )
    : applications;
  const sorted = [...matching].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const { visibleCount, scrollRef, sentinelRef } = useRevealOnScroll(
    sorted.length,
    PAGE_SIZE,
    resetKey,
  );
  const visible = sorted.slice(0, visibleCount);

  const requirementCounts = requirementKindCounts(applications);
  const yearsDistribution = yearsOfExperienceDistribution(applications);

  const subtitle =
    sorted.length === 0
      ? '0 postings'
      : visibleCount < sorted.length
        ? `${visibleCount} of ${sorted.length} postings`
        : `${sorted.length} posting${sorted.length === 1 ? '' : 's'}`;

  return (
    <section className="analytics-panel">
      <div className="analytics-panel__head">
        <h2>{selectedKeyword ? `Requirements mentioning ${selectedKeyword}` : 'Requirements'}</h2>
        <p>{subtitle}</p>
      </div>

      {requirementCounts.total > 0 ? (
        <div className="analytics-summary-strip">
          <span>{requirementCounts.required} required</span>
          <span>{requirementCounts.preferred} preferred</span>
          <span>{requirementCounts.unspecified} unspecified</span>
          {yearsDistribution.length > 0 ? (
            <span className="analytics-summary-strip__years">
              Years stated:{' '}
              {yearsDistribution.map((point) => `${point.years}+ (×${point.count})`).join(', ')}
            </span>
          ) : null}
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <div className="analytics-empty">No postings in range asked for “{selectedKeyword}”.</div>
      ) : (
        <div
          className="analytics-reqs-scroll"
          ref={scrollRef}
          tabIndex={0}
          aria-label="Requirements by posting"
        >
          {visible.map((application) => (
            <article key={application.id} className="analytics-posting">
              <div className="analytics-posting__head">
                <a className="analytics-posting__link" href={applicationPath(application.id)}>
                  <span className="analytics-posting__company">{application.company}</span>{' '}
                  <span className="analytics-posting__role">— {application.roleTitle}</span>
                </a>
                <span className="analytics-posting__meta">{formatDate(application.createdAt)}</span>
              </div>
              {application.jobInfo.requirements.length > 0 ? (
                <ul className="analytics-reqs">
                  {application.jobInfo.requirements.map((requirement) => (
                    <li key={requirement.text} className="analytics-req">
                      {requirement.kind !== 'unspecified' ? (
                        <span className={`requirement-kind requirement-kind--${requirement.kind}`}>
                          {requirement.kind}
                        </span>
                      ) : (
                        <span className="analytics-req__bullet" aria-hidden="true">
                          •
                        </span>
                      )}
                      <span className="analytics-req__text">
                        {highlightTerm(requirement.text, selectedKeyword)}
                        {requirement.yearsOfExperience !== null ? (
                          <span className="analytics-req__years">
                            {' '}
                            · {requirement.yearsOfExperience}+ yrs
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
          <div ref={sentinelRef} />
        </div>
      )}
    </section>
  );
}
