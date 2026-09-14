/**
 * The Analytics view: a retrospective on the postings the candidate has already applied to — which
 * keywords they ask for, and which of them the Profile fails to evidence. Gap analysis, not market
 * intel: the only postings djobi holds are ones already saved as an Application, so this reads as
 * "what have I been applying to lately," never as a survey of the market. See `PROGRESS.md`'s
 * Phase 12 section for the full set of decisions this follows.
 *
 * Client-side aggregation over the array `useApplicationStore` already loaded, the same reasoning
 * `ApplicationsList` filters under: this is a personal-scale dataset, and a filtered endpoint would
 * be inventing backend work for it.
 *
 * Visual design follows the "Keyword Gaps" mockup artifact rather than being invented ad hoc: the
 * card-styled panels, category-grouped keyword sections, full-row frequency bars, the summary strip
 * and the switch-styled Gaps only toggle are all specified there, down to the token values.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  type Application,
  type CoverageVerdict,
  type KeywordCategory,
  type Profile,
} from '@djobi/shared';
import { countByOption, FilterPills } from '../components/FilterPills';
import { FakeSelect } from '../components/FakeSelect';
import { RequirementsPanel } from '../components/RequirementsPanel';
import { stageFilterIcon } from '../components/StageFilterIcon';
import {
  analyticsReport,
  groupByKeywordCategory,
  keywordCoverageSummary,
  keywordRows,
  MIN_DECIDED_FOR_RATE,
  RANGES,
  requirementsReport,
  type Range,
  type ResponseRate,
} from '../lib/analytics';
import { useRemoteProfile } from '../lib/dashboardSession';
import { formatShortDate } from '../lib/format';
import { STAGE_FILTERS, STAGE_LABELS, stageFilterOf, type StageFilter } from '../lib/stages';
import { useRevealOnScroll } from '../lib/useRevealOnScroll';

/**
 * Each range as a pill/option reads.
 *
 * Bare durations, with the group's own label carrying the sense. "Saved" rather than a plain "Last"
 * — this filters `Application.createdAt`, not the posting's own date or anything about the
 * interview, and the two can genuinely diverge: a role logged manually months after applying gets
 * today's date here, not the date it was actually applied to. "Last 14 days" reads fine on its own
 * but answers the wrong question if the reader assumes it means the last 14 days of activity on the
 * application; "Saved" is what says this is about when the row entered djobi.
 */
const RANGE_LABELS: Record<Range, string> = {
  '7d': '7 days',
  '14d': '14 days',
  '30d': '30 days',
  '60d': '60 days',
  all: 'All time',
};

/** Top-of-table cutoff for the keyword bar list; `Load more` grows it by the same amount. */
const KEYWORD_PAGE_SIZE = 25;

const COVERAGE_LABELS: Record<Exclude<CoverageVerdict, 'profile-experience'>, string> = {
  skills: 'In skills',
  experience: 'In experience',
  missing: 'Gap',
};

/**
 * Section headings for the keyword table, grouped rather than the singular per-row labels
 * `KEYWORD_CATEGORY_LABELS` gives the detail page — "Frameworks" reads as a section of many terms,
 * where "Framework" reads as a property of one.
 */
const CATEGORY_GROUP_LABELS: Record<KeywordCategory, string> = {
  language: 'Languages',
  framework: 'Frameworks',
  tool: 'Tools',
  platform: 'Platforms & infrastructure',
  domain: 'Domains',
  'soft-skill': 'Ways of working',
};
const UNCATEGORIZED_LABEL = 'Other';

/** A rate as a whole percentage — `null` reads as `—`, never as `0%`. */
function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * What the summary strip's response rate says on hover — the counts behind the percentage, and,
 * when there are too few of them, why no percentage is shown at all.
 */
function rateTitle(rate: ResponseRate): string {
  const resolved = `${rate.responded} of ${rate.decided} resolved ${rate.decided === 1 ? 'posting' : 'postings'} responded`;
  const pending = rate.pending > 0 ? `, ${rate.pending} still awaiting a reply` : '';
  return rate.rate === null
    ? `Not enough resolved postings to report a rate (needs ${MIN_DECIDED_FOR_RATE}) — ${resolved}${pending}`
    : `${resolved}${pending}`;
}

function SummaryTooltip({ id, label, text }: { id: string; label: string; text: string }) {
  return (
    <span className="analytics-summary__tooltip-wrap">
      <button
        type="button"
        className="analytics-summary__tooltip-trigger"
        aria-label={label}
        aria-describedby={id}
      >
        i
      </button>
      <span className="analytics-summary__tooltip" id={id} role="tooltip">
        {text}
      </span>
    </span>
  );
}

export function Analytics({
  applications,
  range,
  stage,
  onFiltersChange,
  getProfile,
  onUnauthorized,
}: {
  applications: Application[];
  range: Range;
  stage: StageFilter | null;
  onFiltersChange: (range: Range, stage: StageFilter | null) => void;
  getProfile: () => Promise<Profile | null>;
  onUnauthorized: () => void;
}) {
  // Captured once per mount, never a `useMemo`: a range is "the last N days as of when I opened
  // this page," and re-deriving it as the clock ticks would shift the boundary under the reader
  // mid-session. The cost is a dashboard left open past midnight keeps yesterday's boundary until
  // reload — the stability this is for.
  const [today] = useState(() => new Date());
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null);
  const [gapsOnly, setGapsOnly] = useState(false);
  const profileState = useRemoteProfile(getProfile, onUnauthorized);

  // Keep aggregation independent of the table-only controls below: toggling gaps or the minimum
  // count should not rescan every application or recompute profile coverage.
  const report = useMemo(
    () =>
      analyticsReport(applications, {
        range,
        stage,
        asOf: today,
        profile: profileState.kind === 'ready' ? profileState.profile : null,
      }),
    [applications, range, stage, today, profileState],
  );
  const { rangeStartDate, inRange, filtered, frequency, coverageByTerm, gapCount, baseline } =
    report;
  // 5 is a reasonable floor for a range with dozens of postings, but a personal-scale dataset's
  // typical default range (14 days) usually holds a handful — a default that ignores that lands a
  // first visit on "No keywords match these filters," with only a stepper the reader hasn't been
  // introduced to yet as the way out. Scaling the *initial* value down to what this range's own
  // most-repeated keyword actually reaches means a first visit shows something. It's still only a
  // starting point: raising it from here to the signal-only view of a bigger range works exactly
  // as before, and switching ranges later doesn't re-run this — a value the reader set themselves
  // should never reset silently under them.
  const [minAppearances, setMinAppearances] = useState<number>(() => {
    // Read off the report above rather than building a second one: frequency doesn't depend on the
    // profile, so this is the same number the old profile-less report produced.
    const topCount = frequency[0]?.count;
    return Math.max(1, Math.min(5, topCount ?? 1));
  });

  // Keyword selection resets on stage/range alone: it is the requirements panel's own concern (see
  // `RequirementsPanel`'s `resetKey`), not this table's.
  useEffect(() => {
    setSelectedKeyword(null);
  }, [range, stage]);

  const rows = useMemo(
    () =>
      keywordRows(frequency, coverageByTerm, {
        gapsOnly,
        minAppearances,
      }),
    [frequency, coverageByTerm, gapsOnly, minAppearances],
  );

  const {
    visibleCount: visibleKeywordCount,
    scrollRef: keywordScrollRef,
    sentinelRef: keywordSentinelRef,
  } = useRevealOnScroll(
    rows.length,
    KEYWORD_PAGE_SIZE,
    `${range}|${stage ?? ''}|${gapsOnly}|${minAppearances}`,
  );
  // Sliced before grouping: the ranking is global across categories ("top 25 overall"), not a cap
  // per category, so a category can show fewer than its full count once the cutoff lands mid-group.
  const visibleRows = rows.slice(0, visibleKeywordCount);
  const maxCount = frequency[0]?.count ?? 0;
  // Over `rows`, not `visibleRows`: the summary strip describes everything the filters matched,
  // not just what has scrolled into view — see `keywordCoverageSummary`'s own doc comment.
  const keywordSummary = keywordCoverageSummary(rows, coverageByTerm);
  const requirements = useMemo(
    () => requirementsReport(filtered, selectedKeyword),
    [filtered, selectedKeyword],
  );
  // A plain field read, not a derivation — the summed `supportedCount`/`attentionCount` fields
  // live on `requirements` itself now; this is only a shorthand for the per-verdict fields below it.
  const requirementEvidence = requirements.evidence;
  const groups = useMemo(() => groupByKeywordCategory(visibleRows), [visibleRows]);

  const stageCounts = countByOption(STAGE_FILTERS, inRange, (a) => stageFilterOf(a.stage));

  return (
    <div className="analytics">
      <div className="analytics-head">
        <h1>Analytics</h1>
        <p>
          What the roles you applied to keep asking for, and which of those your profile can’t yet
          back up.
        </p>
      </div>

      <div className="analytics-controls">
        <div className="analytics-control-group">
          <span className="analytics-control-label">Stage</span>
          {/* `list-stage-filters` is `ApplicationsList`'s own class for this exact six-pill row —
              reused rather than reinvented so the pills wrap onto a grid of equal columns on a
              normal screen and only fall back to a horizontally scrollable strip on a genuinely
              narrow one, instead of scrolling unconditionally at every width. */}
          <div className="analytics-segmented-filter segmented-filter list-stage-filters">
            <FilterPills
              options={STAGE_FILTERS}
              labels={STAGE_LABELS}
              selected={stage}
              onSelect={(next) => onFiltersChange(range, next)}
              groupLabel="Filter by stage"
              counts={stageCounts}
              allCount={inRange.length}
              renderIcon={stageFilterIcon}
            />
          </div>
        </div>

        <div className="analytics-controls__secondary">
          <div className="analytics-range-select">
            <span className="analytics-control-label">Saved</span>
            <FakeSelect
              value={range}
              options={RANGES}
              labels={RANGE_LABELS}
              ariaLabel="Date range"
              onChange={(next) => onFiltersChange(next, stage)}
              className="analytics-range-select__control"
              valueClassName="analytics-range-select__value"
              caretClassName="analytics-range-select__caret"
              selectClassName="analytics-range-select__input"
            />
          </div>

          <label className="analytics-toggle">
            <input
              type="checkbox"
              aria-label="Gaps only"
              aria-describedby="gaps-only-description"
              checked={gapsOnly}
              disabled={profileState.kind !== 'ready'}
              onChange={(event) => setGapsOnly(event.target.checked)}
            />
            <span className="analytics-toggle__track" />
            <span className="analytics-toggle__copy">
              <span className="analytics-toggle__label">Gaps only</span>
              <span id="gaps-only-description" hidden>
                Show only keywords your profile doesn’t evidence yet.
              </span>
            </span>
          </label>
        </div>
      </div>

      {applications.length === 0 ? null : filtered.length === 0 ? (
        <p className="analytics-summary">
          <span>
            <b>0</b> postings in range
          </span>
          <span>
            {range === 'all'
              ? 'Change the stage filter to see more.'
              : 'Widen the date range or change the stage filter to see more.'}
          </span>
        </p>
      ) : (
        <section className="analytics-summary" aria-label="Analytics overview">
          <div className="analytics-summary__context">
            <div>
              <span className="analytics-summary__overline">Overview</span>
              <strong>
                {rangeStartDate === null
                  ? 'All time'
                  : `${formatShortDate(rangeStartDate)} – ${formatShortDate(today)}`}
              </strong>
            </div>
            <span className="analytics-summary__posting-count">
              {filtered.length} {filtered.length === 1 ? 'posting' : 'postings'}
            </span>
          </div>

          {/* States once, for every meter below, what each color means — rather than leaving a
              reader to infer it from four separate bars, or repeating it in every tooltip. The
              meters' own `aria-label`s already carry the counts a screen reader needs, so this is
              hidden from one rather than read as a fifth, redundant color-only description. */}
          <div className="analytics-summary__legend" aria-hidden="true">
            <span>
              <i className="analytics-summary__legend-dot analytics-summary__legend-dot--good" />
              Evidenced
            </span>
            <span>
              <i className="analytics-summary__legend-dot analytics-summary__legend-dot--warn" />
              Needs confirming
            </span>
            <span>
              <i className="analytics-summary__legend-dot analytics-summary__legend-dot--bad" />
              No evidence
            </span>
          </div>

          <div className="analytics-summary__card">
            <header className="analytics-summary__card-head">
              <span className="analytics-summary__eyebrow">Keyword coverage</span>
              <SummaryTooltip
                id="keyword-coverage-help"
                label="About keyword coverage"
                text={`Minimum ${minAppearances} ${minAppearances === 1 ? 'appearance' : 'appearances'} · ${gapsOnly ? 'Showing gaps only' : `${gapCount} total gaps`}`}
              />
            </header>
            <div className="analytics-summary__metric">
              <strong>{rows.length}</strong>
              <span>
                of {frequency.length} {frequency.length === 1 ? 'keyword' : 'keywords'} shown
              </span>
            </div>
            {profileState.kind === 'ready' ? (
              <>
                <div
                  className="analytics-coverage-meter"
                  role="img"
                  aria-label={`${keywordSummary.evidenced} of ${rows.length} shown keywords evidenced by your profile`}
                  style={
                    {
                      '--analytics-covered':
                        rows.length > 0 ? keywordSummary.evidenced / rows.length : 0,
                    } as CSSProperties
                  }
                >
                  <span />
                </div>
                <div className="analytics-summary__stats">
                  <span>
                    <b>{keywordSummary.evidenced}</b>
                    <small>Evidenced</small>
                  </span>
                  <span>
                    <b className="gap-count">{keywordSummary.gaps}</b>
                    <small>Gaps · {keywordSummary.gapPercent}%</small>
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="analytics-summary__meter-placeholder" aria-hidden="true" />
                <div className="analytics-summary__empty-detail">Coverage unavailable</div>
              </>
            )}
          </div>

          <section className="analytics-summary__card" aria-labelledby="analytics-evidence-title">
            <header className="analytics-summary__card-head">
              <span className="analytics-summary__eyebrow" id="analytics-evidence-title">
                {selectedKeyword ? `Evidence for ${selectedKeyword}` : 'Requirement evidence'}
              </span>
              <SummaryTooltip
                id="requirement-evidence-help"
                label="About requirement evidence"
                text={`${requirementEvidence.scoredPostings} of ${requirementEvidence.scoredPostings + requirementEvidence.unscoredPostings} postings scored. In resume = a resume bullet backs it. In skills = only your skills list does. Left out = your Profile backs it, but this resume dropped it.`}
              />
            </header>
            {requirementEvidence.total > 0 ? (
              <>
                <div className="analytics-summary__metric">
                  <strong>{requirements.supportedCount}</strong>
                  <span>of {requirementEvidence.total} supported</span>
                </div>
                <div
                  className="analytics-coverage-meter analytics-coverage-meter--evidence"
                  role="img"
                  aria-label={`${requirements.supportedCount} of ${requirementEvidence.total} requirements supported by your profile`}
                  style={
                    {
                      '--analytics-covered':
                        requirements.supportedCount / requirementEvidence.total,
                    } as CSSProperties
                  }
                >
                  <span />
                </div>
                {/* "In skills" reuses the keyword table's own wording (`COVERAGE_LABELS`) for the
                    same concept — only the skills list names it — instead of introducing separate
                    jargon for something a reader already learned reading the keyword rows below.
                    The table's parallel term for this stat, "In experience", doesn't fit this box
                    at three columns wide (it truncated to "In experi…"); "In resume" says the same
                    thing — a resume bullet backs it — in a width that survives narrower viewports
                    too. "Left out" has no keyword-table counterpart: it names the one verdict
                    unique to a scored application, a fixable resume mistake rather than a missing
                    profile fact. */}
                <div className="analytics-summary__stats analytics-summary__stats--three">
                  <span
                    aria-label={`${requirementEvidence['direct-evidence']} backed by a resume bullet`}
                  >
                    <b>{requirementEvidence['direct-evidence']}</b>
                    <small>In resume</small>
                  </span>
                  <span aria-label={`${requirementEvidence['skill-only']} named only in skills`}>
                    <b>{requirementEvidence['skill-only']}</b>
                    <small>In skills</small>
                  </span>
                  <span
                    aria-label={`${requirementEvidence['omitted-profile-evidence']} in your Profile but left out of this resume`}
                  >
                    <b>{requirementEvidence['omitted-profile-evidence']}</b>
                    <small>Left out</small>
                  </span>
                </div>
              </>
            ) : (
              <div className="analytics-summary__empty-detail analytics-summary__empty-detail--spanning">
                <strong>No evidence scored yet</strong>
                <span>Save a few more applications and this fills in.</span>
              </div>
            )}
          </section>

          {requirementEvidence.total > 0 ? (
            <section
              className="analytics-summary__card"
              aria-labelledby="analytics-attention-title"
            >
              <header className="analytics-summary__card-head">
                <span className="analytics-summary__eyebrow" id="analytics-attention-title">
                  {selectedKeyword ? `Needs attention for ${selectedKeyword}` : 'Needs attention'}
                </span>
                <SummaryTooltip
                  id="attention-help"
                  label="About requirements needing attention"
                  text="Requirements worth your attention: nothing in your profile confirms them yet."
                />
              </header>
              <div className="analytics-summary__metric">
                <strong>{requirements.attentionCount}</strong>
                <span>of {requirementEvidence.total} requirements</span>
              </div>
              <div
                className="analytics-attention-meter"
                role="img"
                aria-label={`${requirementEvidence['needs-confirmation']} needs confirmation, ${requirementEvidence.unsupported} no supporting evidence`}
              >
                {requirementEvidence['needs-confirmation'] > 0 ? (
                  <span
                    className="is-confirmation"
                    style={{ flexGrow: requirementEvidence['needs-confirmation'] }}
                  />
                ) : null}
                {requirementEvidence.unsupported > 0 ? (
                  <span
                    className="is-unsupported"
                    style={{ flexGrow: requirementEvidence.unsupported }}
                  />
                ) : null}
              </div>
              <div className="analytics-summary__stats">
                <span
                  aria-label={`${requirementEvidence['needs-confirmation']} needs confirmation`}
                >
                  <b>{requirementEvidence['needs-confirmation']}</b>
                  <small>Confirm</small>
                </span>
                <span aria-label={`${requirementEvidence.unsupported} with no supporting evidence`}>
                  <b className="gap-count">{requirementEvidence.unsupported}</b>
                  <small>No evidence</small>
                </span>
              </div>
            </section>
          ) : null}

          {baseline ? (
            <div className="analytics-summary__card">
              <header className="analytics-summary__card-head">
                <span className="analytics-summary__eyebrow">Application outcomes</span>
                <SummaryTooltip
                  id="application-outcomes-help"
                  label="About application outcomes"
                  text={
                    baseline.rate === null
                      ? `Available after ${MIN_DECIDED_FOR_RATE} applications are resolved. ${rateTitle(baseline)}`
                      : `${rateTitle(baseline)}${baseline.pending > 0 ? ` · ${baseline.pending} awaiting response` : ''}`
                  }
                />
              </header>
              {baseline.rate === null ? (
                <>
                  <strong className="analytics-summary__metric analytics-summary__metric--copy">
                    No response rate yet
                  </strong>
                  {/* Not the rate meter's green: nothing here is "good" yet, only "closer to
                      reportable" — a neutral fill keeps that distinct from the real rate below,
                      and replaces the empty placeholder that used to sit here looking unfinished. */}
                  <div
                    className="analytics-coverage-meter analytics-coverage-meter--neutral"
                    role="img"
                    aria-label={`${baseline.decided} of ${MIN_DECIDED_FOR_RATE} resolved applications needed before a response rate can be reported`}
                    style={
                      {
                        '--analytics-covered': Math.min(baseline.decided / MIN_DECIDED_FOR_RATE, 1),
                      } as CSSProperties
                    }
                  >
                    <span />
                  </div>
                  <div className="analytics-summary__stats">
                    <span>
                      <b>{baseline.decided}</b>
                      <small>Resolved</small>
                    </span>
                    <span>
                      <b>{baseline.pending}</b>
                      <small>Awaiting</small>
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <strong className="analytics-summary__metric analytics-summary__metric--rate">
                    <span>{formatRate(baseline.rate)}</span> response rate
                  </strong>
                  <div
                    className="analytics-coverage-meter"
                    role="img"
                    aria-label={`${formatRate(baseline.rate)} response rate — ${baseline.responded} of ${baseline.decided} resolved postings responded`}
                    style={{ '--analytics-covered': baseline.rate } as CSSProperties}
                  >
                    <span />
                  </div>
                  <div className="analytics-summary__stats">
                    <span>
                      <b>{baseline.responded}</b>
                      <small>Responded</small>
                    </span>
                    <span>
                      <b>{baseline.pending}</b>
                      <small>Awaiting</small>
                    </span>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </section>
      )}

      {profileState.kind === 'none' ? (
        <div className="analytics-notice analytics-notice--action">
          <span className="analytics-notice__icon" aria-hidden="true">
            ◐
          </span>
          <div>
            <strong>No profile saved yet</strong>
            <span>
              There’s nothing to compare these keywords against yet. Set up a profile in the
              extension’s options page and this fills in.
            </span>
          </div>
        </div>
      ) : profileState.kind === 'unreachable' ? (
        <div className="analytics-notice analytics-notice--error" role="alert">
          <span className="analytics-notice__icon" aria-hidden="true">
            ⚠
          </span>
          <div>
            <strong>Couldn’t load your profile</strong>
            <span>
              Keyword counts below are complete; coverage is hidden until the backend answers.{' '}
              {profileState.message}
            </span>
          </div>
        </div>
      ) : null}

      {/*
        Five states this page must keep distinct — see `PROGRESS.md`. The range/stage controls
        above stay visible and enabled through every one of them: never hide the control that would
        fix the emptiness.
      */}
      {applications.length === 0 ? (
        <p className="empty-state">
          No applications yet. Fill one in with the extension and hit Save, and it shows up here.
        </p>
      ) : filtered.length === 0 ? null : (
        <div className="analytics-grid">
          <section className="analytics-panel">
            <div className="analytics-panel__head">
              <h2>Keywords</h2>
              <div className="analytics-stepper">
                <span className="analytics-stepper__label" id="min-appearances-label">
                  Min. appearances
                </span>
                <div
                  className="analytics-stepper__control"
                  role="group"
                  aria-labelledby="min-appearances-label"
                >
                  <button
                    type="button"
                    className="analytics-stepper__button"
                    aria-label="Decrease minimum appearances"
                    disabled={minAppearances <= 1}
                    onClick={() => setMinAppearances((count) => Math.max(1, count - 1))}
                  >
                    −
                  </button>
                  <span className="analytics-stepper__value" aria-live="polite">
                    {minAppearances}
                  </span>
                  <button
                    type="button"
                    className="analytics-stepper__button"
                    aria-label="Increase minimum appearances"
                    onClick={() => setMinAppearances((count) => count + 1)}
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {frequency.length === 0 ? (
              <div className="analytics-empty">
                <strong>No keywords extracted</strong>
                None of the postings in this range had keywords worth pulling out.
              </div>
            ) : rows.length === 0 ? (
              <div className="analytics-empty">
                <strong>No keywords match these filters</strong>
                {gapsOnly && minAppearances > 1
                  ? 'Try lowering "Min. appearances", or turn off Gaps only.'
                  : gapsOnly
                    ? 'Your profile backs up every keyword these postings asked for.'
                    : 'Try lowering "Min. appearances".'}
              </div>
            ) : (
              <div
                className="analytics-keywords-scroll"
                ref={keywordScrollRef}
                tabIndex={0}
                aria-label="Keywords by category"
              >
                {groups.map(({ category, items }) => (
                  <div key={category ?? UNCATEGORIZED_LABEL}>
                    <div className="analytics-category">
                      {category === null ? UNCATEGORIZED_LABEL : CATEGORY_GROUP_LABELS[category]}
                    </div>
                    <ul className="analytics-rows">
                      {items.map((row) => {
                        const verdict = coverageByTerm?.get(row.term);
                        const selected = selectedKeyword === row.term;
                        return (
                          <li key={row.term}>
                            <button
                              type="button"
                              className={`analytics-row ${verdict === 'missing' ? 'is-gap' : ''} ${selected ? 'is-selected' : ''}`}
                              style={
                                {
                                  '--w': maxCount > 0 ? row.count / maxCount : 0,
                                } as CSSProperties
                              }
                              aria-pressed={selected}
                              onClick={() => setSelectedKeyword(selected ? null : row.term)}
                            >
                              <span className="analytics-row__term">{row.term}</span>
                              {verdict ? (
                                <span className={`analytics-badge analytics-badge--${verdict}`}>
                                  {
                                    COVERAGE_LABELS[
                                      verdict as Exclude<CoverageVerdict, 'profile-experience'>
                                    ]
                                  }
                                </span>
                              ) : null}
                              <span className="analytics-row__count">{row.count}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                <div ref={keywordSentinelRef} />
              </div>
            )}
          </section>

          <RequirementsPanel
            report={requirements}
            selectedKeyword={selectedKeyword}
            resetKey={`${range}|${stage ?? ''}|${selectedKeyword ?? ''}`}
          />
        </div>
      )}
    </div>
  );
}
