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
import { RequirementsPanel } from '../components/RequirementsPanel';
import {
  analyticsReport,
  MIN_DECIDED_FOR_RATE,
  RANGES,
  type Range,
  type ResponseRate,
} from '../lib/analytics';
import { useRemoteProfile } from '../lib/dashboardSession';
import { formatShortDate } from '../lib/format';
import { STAGE_FILTERS, STAGE_LABELS, stageFilterOf, type StageFilter } from '../lib/stages';
import { useRevealOnScroll } from '../lib/useRevealOnScroll';

const RANGE_LABELS: Record<Range, string> = {
  '7d': '7 days',
  '14d': '14 days',
  '30d': '30 days',
  '60d': '60 days',
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
  const [minAppearances, setMinAppearances] = useState<number>(5);

  const profileState = useRemoteProfile(getProfile, onUnauthorized);

  // Keyword selection resets on stage/range alone: it is the requirements panel's own concern (see
  // `RequirementsPanel`'s `resetKey`), not this table's.
  useEffect(() => {
    setSelectedKeyword(null);
  }, [range, stage]);

  // Keep aggregation independent of the table-only controls below: toggling gaps or the minimum
  // count should not rescan every application or recompute profile coverage.
  const report = useMemo(
    () =>
      analyticsReport(applications, {
        range,
        stage,
        asOf: today,
        minAppearances: 0,
        gapsOnly: false,
        profile: profileState.kind === 'ready' ? profileState.profile : null,
      }),
    [applications, range, stage, today, profileState],
  );
  const { rangeStartDate, inRange, filtered, frequency, coverageByTerm, gapCount, baseline } =
    report;
  const rows = useMemo(
    () =>
      frequency
        .filter((row) => !gapsOnly || coverageByTerm?.get(row.term) === 'missing')
        .filter((row) => row.count >= minAppearances),
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
  const groups = useMemo(() => {
    const byCategory = new Map<string, typeof visibleRows>();
    for (const row of visibleRows) {
      const key = row.category ?? UNCATEGORIZED_LABEL;
      const group = byCategory.get(key) ?? [];
      group.push(row);
      byCategory.set(key, group);
    }
    return [...byCategory.entries()];
  }, [visibleRows]);

  const stageCounts = countByOption(STAGE_FILTERS, inRange, (a) => stageFilterOf(a.stage));

  return (
    <div className="analytics">
      <div className="analytics-head">
        <h1>Analytics</h1>
        <p>
          What the postings you applied to are asking for, and which of those terms your profile
          doesn’t evidence yet.
        </p>
      </div>

      <div className="analytics-controls">
        <div className="analytics-control-group">
          <span className="analytics-control-label">Saved in the last</span>
          <div className="analytics-segmented-filter segmented-filter">
            <div className="filter-pills" role="group" aria-label="Date range">
              {RANGES.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`filter-pill ${range === option ? 'is-selected' : ''}`}
                  aria-pressed={range === option}
                  onClick={() => onFiltersChange(option, stage)}
                >
                  {RANGE_LABELS[option]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="analytics-control-group">
          <span className="analytics-control-label">Stage</span>
          <div className="analytics-segmented-filter segmented-filter">
            <FilterPills
              options={STAGE_FILTERS}
              labels={STAGE_LABELS}
              selected={stage}
              onSelect={(next) => onFiltersChange(range, next)}
              groupLabel="Filter by stage"
              counts={stageCounts}
            />
          </div>
        </div>

        <div className="analytics-toggle-row">
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
              <span id="gaps-only-description" className="analytics-toggle__description">
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
          <span>Widen the range or change the stage filter to see more.</span>
        </p>
      ) : (
        <p className="analytics-summary">
          <span>
            <b>{filtered.length}</b> {filtered.length === 1 ? 'posting' : 'postings'}
          </span>
          <span>
            <b>{frequency.length}</b> distinct {frequency.length === 1 ? 'keyword' : 'keywords'}
          </span>
          {profileState.kind === 'ready' ? (
            <span className="gap-count">
              <b>{gapCount}</b> not evidenced by your profile
            </span>
          ) : null}
          {baseline ? (
            <span title={rateTitle(baseline)}>
              <b>{formatRate(baseline.rate)}</b> response rate
              {baseline.pending > 0 ? ` · ${baseline.pending} pending` : ''}
            </span>
          ) : null}
          <span>
            {formatShortDate(rangeStartDate)} – {formatShortDate(today)}
          </span>
        </p>
      )}

      {profileState.kind === 'none' ? (
        <div className="analytics-notice analytics-notice--action">
          <span className="analytics-notice__icon" aria-hidden="true">
            ◐
          </span>
          <div>
            <strong>No profile saved yet</strong>
            <span>
              Coverage needs a profile to compare against. Set one up in the extension’s options
              page and these keywords will show what you already evidence.
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
                No postings in this range have any extracted keywords.
              </div>
            ) : rows.length === 0 ? (
              <div className="analytics-empty">
                <strong>No keywords match these filters</strong>
                {gapsOnly && minAppearances > 1
                  ? 'Try lowering "Min. appearances" or turning off Gaps only.'
                  : gapsOnly
                    ? 'Every keyword these postings asked for is evidenced somewhere in your profile.'
                    : 'Try lowering "Min. appearances".'}
              </div>
            ) : (
              <div
                className="analytics-keywords-scroll"
                ref={keywordScrollRef}
                tabIndex={0}
                aria-label="Keywords by category"
              >
                {groups.map(([category, items]) => (
                  <div key={category}>
                    <div className="analytics-category">
                      {category === UNCATEGORIZED_LABEL
                        ? UNCATEGORIZED_LABEL
                        : CATEGORY_GROUP_LABELS[category as KeywordCategory]}
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
            applications={filtered}
            selectedKeyword={selectedKeyword}
            resetKey={`${range}|${stage ?? ''}|${selectedKeyword ?? ''}`}
          />
        </div>
      )}
    </div>
  );
}
