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
import { useState, type ReactNode } from 'react';
import { normalizeLabel, type Application, type RequirementEvidenceVerdict } from '@djobi/shared';
import {
  evidenceByRequirement,
  requirementEvidenceRollup,
  requirementKindCounts,
  yearsOfExperienceDistribution,
} from '../lib/analytics';
import { applicationPath, PAGE_SIZE } from '../lib/useHashRoute';
import { useRevealOnScroll } from '../lib/useRevealOnScroll';
import { formatDate } from '../lib/format';

/**
 * What each stored verdict is called on screen. `direct-evidence` has a label because the roll-up
 * counts it, but no requirement row ever wears it: the good case is the common case, and badging
 * every evidenced requirement would bury the four verdicts that mean something is wrong — the same
 * reason `ApplicationDetail` suppresses the `unspecified` requirement-kind badge.
 */
const EVIDENCE_LABELS: Record<RequirementEvidenceVerdict, string> = {
  'direct-evidence': 'Evidenced',
  'skill-only': 'Skill only',
  'omitted-profile-evidence': 'Dropped from resume',
  'needs-confirmation': 'Unconfirmed',
  unsupported: 'No evidence',
};

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
  const [showExperience, setShowExperience] = useState(false);
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

  const requirementCounts = requirementKindCounts(matching);
  const yearsDistribution = yearsOfExperienceDistribution(matching);
  const evidence = requirementEvidenceRollup(matching);

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
            <div className="analytics-summary-strip__years">
              <button
                type="button"
                className="analytics-summary-strip__years-toggle"
                aria-expanded={showExperience}
                aria-controls="experience-requested-breakdown"
                onClick={() => setShowExperience((shown) => !shown)}
              >
                <span>Experience requested</span>
                <span className="analytics-summary-strip__years-total">
                  {yearsDistribution.length}{' '}
                  {yearsDistribution.length === 1 ? 'threshold' : 'thresholds'}
                </span>
              </button>
              {showExperience ? (
                <div
                  className="analytics-summary-strip__years-dropdown"
                  id="experience-requested-breakdown"
                >
                  {yearsDistribution.map((point) => (
                    <span className="analytics-summary-strip__year" key={point.years}>
                      {point.years}+ {point.years === 1 ? 'year' : 'years'}
                      <span className="analytics-summary-strip__year-count">
                        {' '}
                        · {point.count} {point.count === 1 ? 'request' : 'requests'}
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/*
        The verdicts already computed and stored at each save, read back in aggregate. All five are
        shown, so the strip always sums to the requirements it was drawn from — dropping the one
        that reads as least interesting (`needs-confirmation`, which every unparsable years figure
        lands on) would leave a strip of zeros standing over rows visibly badged "Unconfirmed".
        Rendered only when at least one posting carries evidence: `requirementEvidence` is null for every row
        written before the field existed, and a strip of zeros over those would read as "nothing
        was dropped" when the truth is "nothing was checked". `unscoredPostings` states that
        denominator out loud for the mixed history that is the normal case.
      */}
      {evidence.total > 0 ? (
        <div className="analytics-summary-strip analytics-summary-strip--evidence">
          <span>{evidence['direct-evidence']} evidenced</span>
          <span
            className={evidence['omitted-profile-evidence'] > 0 ? 'is-actionable' : undefined}
            title="Your profile had a bullet for these, and the tailored resume dropped it — a selection you can fix, not a skill you lack."
          >
            {evidence['omitted-profile-evidence']} dropped from resume
          </span>
          <span>{evidence['skill-only']} skill only</span>
          <span>{evidence['needs-confirmation']} unconfirmed</span>
          <span>{evidence.unsupported} unevidenced</span>
          {evidence.unscoredPostings > 0 ? (
            <span
              className="analytics-summary-strip__caveat"
              title="These predate requirement matching, or their profile could not be read when they were saved. Nothing backfills them."
            >
              over {evidence.scoredPostings} of{' '}
              {evidence.scoredPostings + evidence.unscoredPostings} postings
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
          {visible.map((application) => {
            const verdicts = evidenceByRequirement(application);
            return (
              <article key={application.id} className="analytics-posting">
                <div className="analytics-posting__head">
                  <a className="analytics-posting__link" href={applicationPath(application.id)}>
                    <span className="analytics-posting__company">{application.company}</span>{' '}
                    <span className="analytics-posting__role">— {application.roleTitle}</span>
                  </a>
                  <span className="analytics-posting__meta">
                    {formatDate(application.createdAt)}
                  </span>
                </div>
                {application.jobInfo.requirements.length > 0 ? (
                  <div className="analytics-req-groups">
                    {[
                      {
                        kind: 'required' as const,
                        requirements: application.jobInfo.requirements.filter(
                          (requirement) => requirement.kind !== 'preferred',
                        ),
                      },
                      {
                        kind: 'preferred' as const,
                        requirements: application.jobInfo.requirements.filter(
                          (requirement) => requirement.kind === 'preferred',
                        ),
                      },
                    ].map(({ kind, requirements }) =>
                      requirements.length > 0 ? (
                        <section
                          key={kind}
                          className={`analytics-req-group analytics-req-group--${kind}`}
                        >
                          <h3
                            className={`analytics-req-group__title requirement-kind requirement-kind--${kind}`}
                          >
                            {kind}
                          </h3>
                          <ul className="analytics-reqs">
                            {requirements.map((requirement) => {
                              const verdict = verdicts.get(requirement.text);
                              return (
                                <li key={requirement.text} className="analytics-req">
                                  <span className="analytics-req__text">
                                    {highlightTerm(requirement.text, selectedKeyword)}
                                    {requirement.yearsOfExperience !== null ? (
                                      <span className="analytics-req__years">
                                        {' '}
                                        · {requirement.yearsOfExperience}+ yrs
                                      </span>
                                    ) : null}
                                    {verdict && verdict.verdict !== 'direct-evidence' ? (
                                      <span
                                        className={`analytics-req__verdict analytics-req__verdict--${verdict.verdict}`}
                                      >
                                        {EVIDENCE_LABELS[verdict.verdict]}
                                      </span>
                                    ) : null}
                                    {verdict?.verdict === 'omitted-profile-evidence' &&
                                    verdict.evidence ? (
                                      <span className="analytics-req__omitted">
                                        Your profile has: “{verdict.evidence}”
                                      </span>
                                    ) : null}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </section>
                      ) : null,
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
          <div ref={sentinelRef} />
        </div>
      )}
    </section>
  );
}
