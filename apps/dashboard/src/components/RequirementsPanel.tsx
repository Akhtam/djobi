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
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  IMPORTANCE_BANDS,
  type RequirementEvidenceVerdict,
  type RequirementImportance,
} from '@djobi/shared';
import { evidenceByRequirement, type RequirementsReport } from '../lib/analytics';
import { BAND_LABELS, groupByImportance, UNBANDED } from '../lib/requirementGroups';
import { applicationPath, PAGE_SIZE } from '../lib/useHashRoute';
import { useRevealOnScroll } from '../lib/useRevealOnScroll';
import { formatDate } from '../lib/format';
import { EVIDENCE_LABELS } from '../lib/stages';

const IMPORTANCE_HELP: Record<RequirementImportance, string> = {
  critical:
    'An explicit must-have, the job title itself, a core daily responsibility, or a legal, language, or work-authorization gate.',
  high: 'A central requirement likely to be assessed during an interview.',
  meaningful: 'A real requirement that matters, though probably not the one that decides it.',
  preferred: "A nice-to-have the posting doesn't present as required.",
  'low-signal': 'Generic boilerplate that says little about whether you fit.',
};

const EVIDENCE_HELP: Record<RequirementEvidenceVerdict, string> = {
  'direct-evidence': 'A resume bullet or stated experience directly supports this requirement.',
  'skill-only': 'Your skills list names it, but no resume bullet shows how you used it.',
  'omitted-profile-evidence': 'Your profile has the experience, but this resume left it out.',
  'needs-confirmation':
    "There's something suggestive in your profile, but not enough to say you meet this.",
  unsupported: 'Nothing in your profile backs this up.',
};

const LEGACY_REQUIREMENT_HELP: Record<string, string> = {
  required: 'The posting explicitly presents these requirements as required.',
  preferred: 'The posting presents these requirements as preferred or nice-to-have.',
  unspecified: "The posting doesn't say whether these are required or just preferred.",
};

function RequirementTooltip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !tooltipRef.current) return;

    const trigger = buttonRef.current.getBoundingClientRect();
    const tooltip = tooltipRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 7;
    const centeredLeft = trigger.left + trigger.width / 2 - tooltip.width / 2;
    const left = Math.min(
      window.innerWidth - tooltip.width - margin,
      Math.max(margin, centeredLeft),
    );
    const top =
      trigger.top >= tooltip.height + gap + margin
        ? trigger.top - tooltip.height - gap
        : Math.min(window.innerHeight - tooltip.height - margin, trigger.bottom + gap);

    setPosition({ left, top: Math.max(margin, top) });
  }, [open]);

  return (
    <span
      className="requirement-tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button ref={buttonRef} type="button" aria-label={label} aria-describedby={id}>
        i
      </button>
      {open
        ? createPortal(
            <span
              ref={tooltipRef}
              className="requirement-tooltip__content"
              id={id}
              role="tooltip"
              style={position ?? undefined}
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/**
 * Splits `text` on a case-insensitive match of `term`, wrapping each match in `<mark>`. Built with
 * `String.split` against a capturing regex rather than an HTML string and `dangerouslySetInnerHTML`
 * — the posting text is real data, and a term containing HTML-significant characters must not be
 * able to inject markup into the page.
 */
function highlightTerm(text: string, term: string | null): ReactNode {
  if (!term) return text;
  const escaped = term
    .trim()
    .split(/[\s\u2010-\u2015-]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\u2010-\\u2015-]+');
  if (!escaped) return text;
  const parts = text.split(new RegExp(`(${escaped})`, 'i'));
  if (parts.length === 1) return text;
  // `String.split` against a one-group capturing regex alternates non-match/match/non-match/…
  // regardless of content, so the odd indices are exactly the substrings that matched.
  return parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

export function RequirementsPanel({
  report,
  selectedKeyword,
  resetKey,
}: {
  /** Already scoped to range, stage, and keyword by the Analytics view. */
  report: RequirementsReport;
  /**
   * The term selected from the keyword frequency table, or `null` for every posting in range.
   * Matched via `normalizeKeyword` — the same grouping the frequency table itself uses — so
   * selecting the displayed spelling still finds postings that used a case, whitespace or dash
   * variant. Also the term highlighted inside each shown requirement's text.
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
  const [showImportance, setShowImportance] = useState(false);
  const { sorted, requirementCounts, bandCounts, anyBanded, yearsDistribution } = report;
  const classifiedRequirements = bandCounts.total - bandCounts.unbanded;

  const { visibleCount, scrollRef, sentinelRef } = useRevealOnScroll(
    sorted.length,
    PAGE_SIZE,
    resetKey,
  );
  const visible = sorted.slice(0, visibleCount);

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
        <div className="analytics-summary-strip requirements-overview">
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

          <section className="requirements-summary-card" aria-labelledby="importance-summary-title">
            <button
              type="button"
              className="requirements-summary-card__head"
              aria-expanded={showImportance}
              aria-controls="importance-summary-breakdown"
              onClick={() => setShowImportance((shown) => !shown)}
            >
              <h3 id="importance-summary-title">Importance</h3>
              {/* Only where bands actually exist. For a range of postings extracted before
                  importance bands, every requirement is unbanded and this would read "0 of 87
                  classified" above a populated kind breakdown — reporting an absence of decisive
                  requirements where the truth is that none were ever assessed. */}
              {anyBanded ? (
                <span>
                  {classifiedRequirements} of {bandCounts.total} classified
                </span>
              ) : null}
            </button>
            {showImportance ? (
              <div className="requirements-summary-grid" id="importance-summary-breakdown">
                {anyBanded
                  ? IMPORTANCE_BANDS.map((band) => (
                      <span
                        key={band}
                        className={`requirements-summary-stat is-${band}`}
                        aria-label={`${bandCounts[band]} ${BAND_LABELS[band]}`}
                      >
                        <b>{bandCounts[band]}</b>
                        <span>
                          {BAND_LABELS[band]}
                          <RequirementTooltip
                            label={`About ${BAND_LABELS[band]} importance`}
                            text={IMPORTANCE_HELP[band]}
                          />
                        </span>
                      </span>
                    ))
                  : (
                      [
                        [requirementCounts.required, 'required'],
                        [requirementCounts.preferred, 'preferred'],
                        [requirementCounts.unspecified, 'unspecified'],
                      ] as const
                    ).map(([count, label]) => (
                      <span
                        key={label}
                        className="requirements-summary-stat"
                        aria-label={`${count} ${label}`}
                      >
                        <b>{count}</b>
                        <span>
                          {label}
                          <RequirementTooltip
                            label={`About ${label} requirements`}
                            text={LEGACY_REQUIREMENT_HELP[label]}
                          />
                        </span>
                      </span>
                    ))}
                {anyBanded && bandCounts.unbanded > 0 ? (
                  <span
                    className="requirements-summary-stat is-unbanded"
                    aria-label={`${bandCounts.unbanded} ${BAND_LABELS[UNBANDED]}`}
                  >
                    <b>{bandCounts.unbanded}</b>
                    <span>
                      {BAND_LABELS[UNBANDED]}
                      <RequirementTooltip
                        label="About not assessed"
                        text="These requirements weren't sorted into an importance band."
                      />
                    </span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>
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
            const { groups, hiddenCount } = groupByImportance(application.jobInfo.requirements);
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
                    {groups.map(({ key, requirements }) => (
                      <section
                        key={key}
                        className={`analytics-req-group analytics-req-group--${key}`}
                      >
                        <div className="analytics-req-group__title-row">
                          <h3
                            className={`analytics-req-group__title requirement-band requirement-band--${key}`}
                            // `title` rather than a `RequirementTooltip` per group: this heading
                            // repeats once per band *per posting* (a busy range can hold 100-200),
                            // and the popover's own explanation already lives once in the
                            // "Importance" summary card above. No `tabIndex` to go with it — a
                            // browser renders `title` on hover only, never on keyboard focus, so
                            // making a non-interactive heading focusable would buy a tab stop per
                            // band per posting and show the reader nothing when they landed on it.
                            title={
                              key !== UNBANDED
                                ? IMPORTANCE_HELP[key]
                                : 'No importance band was assigned to these requirements.'
                            }
                          >
                            {BAND_LABELS[key]}
                          </h3>
                        </div>
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
                                      className={`requirement-verdict requirement-verdict--${verdict.verdict}`}
                                      // See the group heading above — same reasoning, and the badge
                                      // label ("Skill only", "Unsupported") carries the meaning on
                                      // its own. `RequirementList` renders this badge bare.
                                      title={EVIDENCE_HELP[verdict.verdict]}
                                    >
                                      {EVIDENCE_LABELS[verdict.verdict]}
                                    </span>
                                  ) : null}
                                  {verdict?.verdict === 'omitted-profile-evidence' &&
                                  verdict.evidence ? (
                                    <span className="requirement-omitted">
                                      Your profile has: “{verdict.evidence}”
                                    </span>
                                  ) : null}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    ))}
                    {hiddenCount > 0 ? (
                      <p className="analytics-req-groups__trimmed">
                        +{hiddenCount} more requirement
                        {hiddenCount === 1 ? '' : 's'} not listed
                      </p>
                    ) : null}
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
