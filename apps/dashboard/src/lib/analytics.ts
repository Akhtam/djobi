/**
 * Pure aggregation over the candidate's saved Applications for the Analytics view — a retrospective
 * gap analysis. Plain functions over an already-filtered `Application[]`: no fetch, no React, and
 * no clock (`rangeStart` takes `today`).
 */
import {
  baseResumeOf,
  keywordCoverage,
  normalizeKeyword,
  type Application,
  type ApplicationStage,
  type CoverageVerdict,
  type KeywordCategory,
  type Profile,
  type RequirementEvidenceEntry,
  type RequirementEvidenceVerdict,
  type RequirementImportance,
  type RequirementKind,
} from '@djobi/shared';
import { stageFilterOf, type StageFilter } from './stages.js';

/**
 * The Analytics date ranges; `'14d'` is the default. `'all'` exists because ranges filter by save
 * date, so short ranges mostly hold unanswered applications — keyword recurrence and response rate
 * need volume.
 */
export const RANGES = ['7d', '14d', '30d', '60d', 'all'] as const;
/** One of {@link RANGES} — a URL value (`?range=`), not free-form. */
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '14d';

/** The bounded ranges. `'all'` is absent by construction, which is what makes it unforgettable. */
type BoundedRange = Exclude<Range, 'all'>;

const RANGE_DAYS: Record<BoundedRange, number> = { '7d': 7, '14d': 14, '30d': 30, '60d': 60 };

/**
 * Local midnight of `today − (n − 1)` days, so a 7-day range is seven calendar days ending today.
 * Local, not UTC, so the cutoff doesn't shift with timezone. Compared against `createdAt` (when the
 * row was saved). `null` for `'all'` — no boundary, rather than a fake epoch the view would print.
 */
export function rangeStart(range: Range, today: Date): Date | null {
  if (range === 'all') return null;
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  midnight.setDate(midnight.getDate() - (RANGE_DAYS[range] - 1));
  return midnight;
}

/** The key the count with the highest value in `counts`, alphabetical tie-break for determinism. */
function mostFrequent<T extends string>(counts: Map<T, number>): T | null {
  let winner: T | null = null;
  let winnerCount = -1;
  for (const [key, count] of counts) {
    if (count > winnerCount || (count === winnerCount && winner !== null && key < winner)) {
      winner = key;
      winnerCount = count;
    }
  }
  return winner;
}

/** One row of the keyword frequency report — see {@link keywordFrequency}. */
export interface KeywordFrequencyRow {
  /** The most frequent original spelling among postings that asked for this term. */
  term: string;
  /** The most frequent category attached to this term, or `null` if every occurrence lacked one. */
  category: KeywordCategory | null;
  /** Postings that asked for this term — not occurrences. See {@link keywordFrequency}. */
  count: number;
}

/**
 * Every extracted keyword grouped by {@link normalizeKeyword}, sorted by count then alphabetically.
 * **Counts postings, not mentions**: each application contributes a term at most once.
 */
export function keywordFrequency(applications: Application[]): KeywordFrequencyRow[] {
  const termCounts = new Map<string, Map<string, number>>();
  const categoryCounts = new Map<string, Map<KeywordCategory, number>>();
  const postingCounts = new Map<string, number>();

  for (const application of applications) {
    const seen = new Set<string>();
    for (const keyword of application.jobInfo.keywords) {
      const normalized = normalizeKeyword(keyword.term);
      if (!normalized) continue;

      const spellings = termCounts.get(normalized) ?? new Map<string, number>();
      spellings.set(keyword.term, (spellings.get(keyword.term) ?? 0) + 1);
      termCounts.set(normalized, spellings);

      if (keyword.category) {
        const categories = categoryCounts.get(normalized) ?? new Map<KeywordCategory, number>();
        categories.set(keyword.category, (categories.get(keyword.category) ?? 0) + 1);
        categoryCounts.set(normalized, categories);
      }

      if (!seen.has(normalized)) {
        seen.add(normalized);
        postingCounts.set(normalized, (postingCounts.get(normalized) ?? 0) + 1);
      }
    }
  }

  const rows = [...postingCounts.entries()].map(([normalized, count]) => ({
    term: mostFrequent(termCounts.get(normalized)!)!,
    category: mostFrequent(categoryCounts.get(normalized) ?? new Map()),
    count,
  }));

  return rows.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

/**
 * Requirement counts per {@link RequirementKind}, `unspecified` counted explicitly (it means "no
 * distinction drawn", not "not required").
 */
export interface RequirementKindCounts extends Record<RequirementKind, number> {
  /** `required + preferred + unspecified` — every requirement these counts are drawn from. */
  total: number;
}

export function requirementKindCounts(applications: Application[]): RequirementKindCounts {
  const counts: RequirementKindCounts = { required: 0, preferred: 0, unspecified: 0, total: 0 };
  for (const application of applications) {
    for (const requirement of application.jobInfo.requirements) {
      counts[requirement.kind] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

/**
 * Requirement counts per {@link RequirementImportance} band. **`unbanded` is its own line** — older
 * requirements were never assessed, which isn't `low-signal`. Counts only: never summed into a
 * weight, averaged, or shown as a percentage.
 */
export interface RequirementImportanceCounts extends Record<RequirementImportance, number> {
  /** Requirements carrying no band — extracted before importance existed, or left unassessed. */
  unbanded: number;
  /** Every requirement these counts are drawn from, banded and unbanded alike. */
  total: number;
}

export function requirementImportanceCounts(
  applications: Application[],
): RequirementImportanceCounts {
  const counts: RequirementImportanceCounts = {
    critical: 0,
    high: 0,
    meaningful: 0,
    preferred: 0,
    'low-signal': 0,
    unbanded: 0,
    total: 0,
  };
  for (const application of applications) {
    for (const requirement of application.jobInfo.requirements) {
      if (requirement.importance === null) counts.unbanded += 1;
      else counts[requirement.importance] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

/**
 * What `profile`'s Base Resume evidences of every term in `frequency`, keyed by term. Scored
 * against a synthesized `{ keywords }`, since an aggregated term has no single `postingSpelling`.
 */
export function coverageForKeywords(
  frequency: KeywordFrequencyRow[],
  profile: Profile,
): Map<string, CoverageVerdict> {
  const resume = baseResumeOf(profile);
  const coverage = keywordCoverage(
    resume,
    {
      keywords: frequency.map((row) => ({
        term: row.term,
        category: row.category,
        postingSpelling: null,
      })),
    },
    profile,
  );
  return new Map(coverage.map((entry) => [entry.keyword, entry.verdict]));
}

/** One point of {@link yearsOfExperienceDistribution} — how many requirements stated `years`. */
export interface YearsOfExperienceCount {
  years: number;
  count: number;
}

/**
 * The years threshold one requirement states: the structured field, else (for older rows) a number
 * like "3+ years" in its text. At most one value per requirement.
 */
function statedYears(requirement: Application['jobInfo']['requirements'][number]): number[] {
  if (requirement.yearsOfExperience !== null) return [requirement.yearsOfExperience];

  const pattern =
    /\b(\d+(?:\.\d+)?)\s*(?:(?:[-\u2013\u2014]|to)\s*\d+(?:\.\d+)?|\+|or\s+more)?\s*(?:years?|yrs?)\b/gi;
  const match = pattern.exec(requirement.text);
  return match ? [Number(match[1])] : [];
}

/**
 * How many requirements state each years threshold, ascending. Requirements stating none are
 * excluded, not bucketed.
 */
export function yearsOfExperienceDistribution(
  applications: Application[],
): YearsOfExperienceCount[] {
  const counts = new Map<number, number>();
  for (const application of applications) {
    for (const requirement of application.jobInfo.requirements) {
      for (const years of statedYears(requirement)) {
        counts.set(years, (counts.get(years) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([years, count]) => ({ years, count }))
    .sort((a, b) => a.years - b.years);
}

/**
 * Whether a posting ever came back, from its {@link ApplicationStage}:
 *
 * - `responded` — a screen, onsite, offer, or `rejected` (after contact).
 * - `no-response` — `rejected_ats`.
 * - `pending` — `applied`; never counted as a "no".
 *
 * Relies on the candidate distinguishing `rejected` from `rejected_ats`. `stage` has no history, so
 * this says *whether* a posting responded, not how far or how fast.
 */
export type Outcome = 'responded' | 'no-response' | 'pending';

export function outcomeOf(stage: ApplicationStage): Outcome {
  if (stage === 'applied') return 'pending';
  if (stage === 'rejected_ats') return 'no-response';
  return 'responded';
}

/**
 * Resolved applications needed before a rate is shown; below this `rate` is `null` and only counts
 * are shown.
 */
export const MIN_DECIDED_FOR_RATE = 5;

/** Outcomes across some set of applications — see {@link responseRate}. */
export interface ResponseRate {
  responded: number;
  /** `responded + noResponse` — the applications that resolved, and the rate's denominator. */
  decided: number;
  /** Still `applied`. Excluded from `decided` entirely, never counted as a rejection. */
  pending: number;
  /** `responded / decided`, or `null` ("not enough data", never zero) below the minimum. */
  rate: number | null;
}

/**
 * How often applications came back. **Pending ones are excluded from the denominator** — otherwise
 * recent applications would drag the rate down; `pending` is reported alongside.
 */
export function responseRate(applications: Application[]): ResponseRate {
  let responded = 0;
  let noResponse = 0;
  let pending = 0;
  for (const application of applications) {
    const outcome = outcomeOf(application.stage);
    if (outcome === 'responded') responded += 1;
    else if (outcome === 'no-response') noResponse += 1;
    else pending += 1;
  }
  const decided = responded + noResponse;
  return {
    responded,
    decided,
    pending,
    rate: decided >= MIN_DECIDED_FOR_RATE ? responded / decided : null,
  };
}

/**
 * The stored per-requirement verdicts (`Application.requirementEvidence`) summed across postings —
 * "did the resume I sent evidence what was asked", including the fixable
 * `omitted-profile-evidence`.
 *
 * **Scored postings only**: rows without verdicts (older, or Profile unreadable at save) are
 * counted in `unscoredPostings` so callers state the denominator.
 */
export interface RequirementEvidenceRollup extends Record<RequirementEvidenceVerdict, number> {
  /** Every requirement these verdicts are drawn from. */
  total: number;
  /** Postings carrying a `requirementEvidence` array — the ones `total` is drawn from. */
  scoredPostings: number;
  /** Postings whose `requirementEvidence` is `null`; contributed nothing to any count above. */
  unscoredPostings: number;
}

export function requirementEvidenceRollup(applications: Application[]): RequirementEvidenceRollup {
  const rollup: RequirementEvidenceRollup = {
    'direct-evidence': 0,
    'skill-only': 0,
    'omitted-profile-evidence': 0,
    'needs-confirmation': 0,
    unsupported: 0,
    total: 0,
    scoredPostings: 0,
    unscoredPostings: 0,
  };
  for (const application of applications) {
    if (application.requirementEvidence === null) {
      rollup.unscoredPostings += 1;
      continue;
    }
    rollup.scoredPostings += 1;
    for (const entry of application.requirementEvidence) {
      rollup[entry.verdict] += 1;
      rollup.total += 1;
    }
  }
  return rollup;
}

/**
 * One application's stored verdicts keyed by requirement text (the only key stored, and written
 * from the same source in the same save). Empty for an unscored row.
 */
export function evidenceByRequirement(
  application: Application,
): Map<string, RequirementEvidenceEntry> {
  return new Map(
    (application.requirementEvidence ?? []).map((entry) => [entry.requirement.text, entry]),
  );
}

/** Inputs whose changes require rebuilding the application-level report. */
export interface AnalyticsReportFilters {
  range: Range;
  stage: StageFilter | null;
  /**
   * "Now," as the view pinned it — see {@link rangeStart}'s own note on why the clock isn't read
   * here.
   */
  asOf: Date;
  /** `null` while no Profile is available yet; coverage is skipped entirely. */
  profile: Profile | null;
}

/**
 * Everything the Analytics view derives from one filtered set. Table-only controls go through
 * {@link keywordRows} so they don't rescan every application.
 */
export interface AnalyticsReport {
  /** The window's first day, or `null` for `'all'` — see {@link rangeStart}. */
  rangeStartDate: Date | null;
  /** Every application in range, before the stage filter — what the stage pills count against. */
  inRange: Application[];
  /** In range and matching the stage filter — the population every field below is drawn from. */
  filtered: Application[];
  /** Every keyword `filtered` asked for, before table-only filters narrow what is rendered. */
  frequency: KeywordFrequencyRow[];
  /** `null` until `filters.profile` is given. */
  coverageByTerm: Map<string, CoverageVerdict> | null;
  /** How many of `frequency` are gaps — the summary strip's count regardless of table filters. */
  gapCount: number;
  /**
   * `null` when `filters.stage` narrows the population — see {@link responseRate}'s own caution.
   */
  baseline: ResponseRate | null;
}

export function analyticsReport(
  applications: Application[],
  filters: AnalyticsReportFilters,
): AnalyticsReport {
  const rangeStartDate = rangeStart(filters.range, filters.asOf);
  const inRange =
    rangeStartDate === null
      ? applications
      : applications.filter((application) => new Date(application.createdAt) >= rangeStartDate);
  const filtered = filters.stage
    ? inRange.filter((application) => stageFilterOf(application.stage) === filters.stage)
    : inRange;

  const frequency = keywordFrequency(filtered);
  const coverageByTerm = filters.profile ? coverageForKeywords(frequency, filters.profile) : null;
  const gapCount = coverageByTerm
    ? frequency.filter((row) => coverageByTerm.get(row.term) === 'missing').length
    : 0;

  // Suppressed entirely while a stage filter is on — see `responseRate`'s own note: a population
  // selected on the outcome being measured reports a rate that isn't one.
  const baseline = filters.stage === null ? responseRate(filtered) : null;

  return { rangeStartDate, inRange, filtered, frequency, coverageByTerm, gapCount, baseline };
}

export interface KeywordRowsFilters {
  /** Keeps a keyword row only once at least this many postings asked for it. */
  minAppearances: number;
  /** Narrows the rows to keywords the Profile does not evidence. */
  gapsOnly: boolean;
}

/** Applies the cheap table-only controls without rebuilding the application-level report. */
export function keywordRows(
  frequency: KeywordFrequencyRow[],
  coverageByTerm: Map<string, CoverageVerdict> | null,
  filters: KeywordRowsFilters,
): KeywordFrequencyRow[] {
  // Nothing can be confirmed as a gap without coverage to score against. The UI keeps this state
  // unreachable by disabling the toggle until a Profile has loaded, but the selector remains total.
  return frequency
    .filter((row) => !filters.gapsOnly || coverageByTerm?.get(row.term) === 'missing')
    .filter((row) => row.count >= filters.minAppearances);
}

/**
 * How many of a set of keyword rows the Profile does and doesn't back up — see {@link
 * keywordCoverageSummary}.
 */
export interface KeywordCoverageSummary {
  evidenced: number;
  gaps: number;
  /** `0` for an empty `rows`, never `NaN`. */
  gapPercent: number;
}

/**
 * The gap count for the summary strip, over whichever `rows` the caller passes (all matched rows
 * vs. those scrolled into view).
 */
export function keywordCoverageSummary(
  rows: readonly KeywordFrequencyRow[],
  coverageByTerm: Map<string, CoverageVerdict> | null,
): KeywordCoverageSummary {
  // Same "nothing can be confirmed as a gap without coverage to score against" rule `keywordRows`
  // applies to `gapsOnly` — without a Profile, every row reads as evidenced rather than as a gap.
  const gaps = coverageByTerm
    ? rows.filter((row) => coverageByTerm.get(row.term) === 'missing').length
    : 0;
  const evidenced = rows.length - gaps;
  const gapPercent = rows.length > 0 ? Math.round((gaps / rows.length) * 100) : 0;
  return { evidenced, gaps, gapPercent };
}

/** One category's rows — see {@link groupByKeywordCategory}. */
export interface KeywordCategoryGroup {
  /**
   * `null` groups every row whose own category is unset; the display label is the caller's copy.
   */
  category: KeywordCategory | null;
  items: KeywordFrequencyRow[];
}

/**
 * Groups `rows` by category, preserving row order; categories come out in first-appearance order.
 */
export function groupByKeywordCategory(
  rows: readonly KeywordFrequencyRow[],
): KeywordCategoryGroup[] {
  const byCategory = new Map<KeywordCategory | null, KeywordFrequencyRow[]>();
  for (const row of rows) {
    const group = byCategory.get(row.category) ?? [];
    group.push(row);
    byCategory.set(row.category, group);
  }
  return [...byCategory.entries()].map(([category, items]) => ({ category, items }));
}

/** Everything `RequirementsPanel` renders for one keyword selection. */
export interface RequirementsReport {
  /** `applications`, narrowed to postings that asked for the selected keyword — or all, if none. */
  matching: Application[];
  /** `matching`, newest first — what the panel actually lists. */
  sorted: Application[];
  requirementCounts: RequirementKindCounts;
  bandCounts: RequirementImportanceCounts;
  /**
   * Whether anything in `matching` carries an importance band at all — see
   * `RequirementImportanceCounts`.
   */
  anyBanded: boolean;
  yearsDistribution: YearsOfExperienceCount[];
  evidence: RequirementEvidenceRollup;
  /**
   * Requirements the Profile backs somehow: `direct-evidence` + `skill-only` +
   * `omitted-profile-evidence`.
   */
  supportedCount: number;
  /**
   * `evidence`'s two verdicts that mean the candidate still has something to do —
   * `needs-confirmation`, `unsupported` — summed.
   */
  attentionCount: number;
}

export function requirementsReport(
  applications: Application[],
  selectedKeyword: string | null,
): RequirementsReport {
  const needle = selectedKeyword ? normalizeKeyword(selectedKeyword) : null;
  const matching = needle
    ? applications.filter((application) =>
        application.jobInfo.keywords.some((keyword) => normalizeKeyword(keyword.term) === needle),
      )
    : applications;
  const sorted = matching.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

  const requirementCounts = requirementKindCounts(matching);
  const bandCounts = requirementImportanceCounts(matching);
  const anyBanded = bandCounts.total > bandCounts.unbanded;
  const yearsDistribution = yearsOfExperienceDistribution(matching);
  const evidence = requirementEvidenceRollup(matching);
  const supportedCount =
    evidence['direct-evidence'] + evidence['skill-only'] + evidence['omitted-profile-evidence'];
  const attentionCount = evidence['needs-confirmation'] + evidence.unsupported;

  return {
    matching,
    sorted,
    requirementCounts,
    bandCounts,
    anyBanded,
    yearsDistribution,
    evidence,
    supportedCount,
    attentionCount,
  };
}
