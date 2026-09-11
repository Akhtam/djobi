/**
 * Pure aggregation over the applications the candidate has already saved — the retrospective gap
 * analysis Phase 12's Analytics view reads from. See `PROGRESS.md`'s Phase 12 section for the full
 * set of decisions this follows; the ones this module embodies are repeated below as they come up.
 *
 * Everything here is a plain function over an `Application[]` a caller already has and already
 * filtered — no fetch, no clock read, no React. `rangeStart` takes `today` as a parameter rather
 * than reading the system clock itself, which is what keeps every test in this module clock-free:
 * only the view that mounts `rangeStart` against the real clock needs to freeze time, and it pays
 * that cost once rather than every function here paying it for its own sake.
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
 * The Analytics view's date ranges. `'7d'` is the default so the first reading stays focused on the
 * candidate's most recent activity.
 */
export const RANGES = ['7d', '14d', '30d', '60d'] as const;
/** One of {@link RANGES} — a URL value (`?range=`), not free-form. */
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '7d';

const RANGE_DAYS: Record<Range, number> = { '7d': 7, '14d': 14, '30d': 30, '60d': 60 };

/**
 * Local midnight of `today − (n − 1)` days, so a 7-day range is seven calendar days with `today`
 * as the last — not eight. Local rather than UTC: a cutoff that jumps by hours with the reader's
 * timezone is a cutoff nobody can predict. Callers compare this against `Application.createdAt` —
 * when the candidate *saved* the row, not when the posting was published, since djobi never
 * captures the latter and the question this range answers is "what have I been applying to
 * lately."
 */
export function rangeStart(range: Range, today: Date): Date {
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
 * Every keyword `applications` extracted, grouped by {@link normalizeKeyword}. The extraction
 * prompt remains responsible for collapsing synonyms such as `K8s` and `Kubernetes`; this prevents
 * case, whitespace and dash variants of the same canonical name from splitting. Sorted by count
 * descending, alphabetical tie-break so ordering is stable across renders.
 *
 * **A keyword's count is postings that asked, not mentions.** One `Set` per application before
 * counting, so a posting listing a term twice — or under two spellings that normalize the same —
 * still counts once toward this term. Counting mentions instead would measure how repetitive a
 * posting was, not how often the term came up.
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
 * How many `requirements` across `applications` fell into each {@link RequirementKind} — the
 * structured field the requirement's own *text* cannot give, since sentences do not repeat across
 * postings (see `PROGRESS.md`).
 *
 * All three kinds are counted explicitly, `unspecified` included, rather than derived as
 * `total - required - preferred`: `unspecified` means the posting drew no distinction, which is not
 * the same fact as "not required," and collapsing it into a denominator would report a false rate
 * for whichever kind absorbed it.
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
 * How many `requirements` across `applications` fell into each {@link RequirementImportance} band.
 *
 * Strictly more informative than {@link requirementKindCounts} beside it, for the same reason
 * `requirementEvidence` is more informative than `keywordCoverage`: `kind` records how a posting
 * *phrased* a requirement, while the band records how much it *matters* in that posting, which is
 * the thing a reader can act on.
 *
 * **`unbanded` is reported, never folded away.** Most of the stored history predates importance
 * entirely. Those requirements are not `low-signal` ones — nothing assessed them — so they are
 * counted on their own line rather than absorbed into the lowest band or quietly dropped from a
 * denominator, the same discipline {@link requirementEvidenceRollup} follows with its unscored
 * postings.
 *
 * These are counts, and only counts. Nothing here may be summed into a weight, averaged, or shown
 * as a percentage: a band is a label, and an importance figure on screen is a figure someone will
 * try to raise.
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
 * What `profile`'s Base Resume evidences of every term in `frequency`, keyed by {@link
 * KeywordFrequencyRow.term}. Scored against a synthesized `{ keywords: distinct }`, not a real
 * posting's `JobInfo` — the same reasoning that already leaves `keywordCoverage`'s second argument
 * without the rest of `JobInfo`'s fields: `postingSpelling` is per-posting, and a term aggregated
 * across many postings has no single one to give it.
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
 * The year threshold stated in one requirement, if any. The structured field is authoritative;
 * persisted requirements saved before that field existed fall back to scanning their original text
 * for a number like "3+ years". Returns at most one value, so a requirement contributes to a single
 * bucket rather than every number its text happens to mention.
 */
function statedYears(requirement: Application['jobInfo']['requirements'][number]): number[] {
  if (requirement.yearsOfExperience !== null) return [requirement.yearsOfExperience];

  const pattern =
    /\b(\d+(?:\.\d+)?)\s*(?:(?:[-\u2013\u2014]|to)\s*\d+(?:\.\d+)?|\+|or\s+more)?\s*(?:years?|yrs?)\b/gi;
  const match = pattern.exec(requirement.text);
  return match ? [Number(match[1])] : [];
}

/**
 * How many requirements state each years-of-experience threshold across `applications`, ascending
 * by years. Requirements with no stated figure — the common case — are excluded rather than counted
 * under a `null` bucket: this reports the distribution of what postings *did* state, not a census
 * of what they left silent.
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
 * What an application's {@link ApplicationStage} says about whether the posting ever came back.
 *
 * - `responded` — a human engaged: a screen, an onsite, an offer, or a `rejected` that is not
 *   `rejected_ats`.
 * - `no-response` — `rejected_ats`, the rejection that never reached a person.
 * - `pending` — `applied`, which is not a "no" yet and must never be counted as one.
 *
 * **This leans on `rejected` and `rejected_ats` being kept distinct**, which is the whole reason
 * `ApplicationStageSchema` carries both. A candidate who marks every rejection `rejected` reads as
 * a 100% response rate here — the mapping cannot detect that, and inventing a heuristic to guess
 * around it would be fabricating an outcome the record never stated, the same guess this app's
 * extraction prompts already forbid on the way in.
 *
 * **And `stage` is a scalar with no history**, so a `rejected` row cannot say how far it got before
 * it ended. This reports *whether* a posting responded, never *how far* or *how fast*; the funnel
 * and time-to-response questions need stage-transition timestamps the `applications` table does not
 * record today.
 */
export type Outcome = 'responded' | 'no-response' | 'pending';

export function outcomeOf(stage: ApplicationStage): Outcome {
  if (stage === 'applied') return 'pending';
  if (stage === 'rejected_ats') return 'no-response';
  return 'responded';
}

/**
 * Applications that must have *resolved* before a rate is reported at all. Below this, `rate` is
 * `null` and callers show the counts alone: three applications cannot distinguish a 33% response
 * rate from a 67% one, and a page that prints a percentage over that sample manufactures
 * confidence the data does not hold.
 */
export const MIN_DECIDED_FOR_RATE = 5;

/** Outcomes across some set of applications — see {@link responseRate}. */
export interface ResponseRate {
  responded: number;
  /** `responded + noResponse` — the applications that resolved, and the rate's denominator. */
  decided: number;
  /** Still `applied`. Excluded from `decided` entirely, never counted as a rejection. */
  pending: number;
  /**
   * `responded / decided`, or `null` when fewer than {@link MIN_DECIDED_FOR_RATE} have resolved.
   * `null` means "not enough data to say", never "zero".
   */
  rate: number | null;
}

/**
 * How often `applications` came back at all.
 *
 * **Pending applications are excluded from the denominator, not counted against it.** A week's
 * worth of applications is mostly `applied`, and dividing by them would report a collapsing
 * response rate that measures nothing but recency — the censoring problem, and the one way this
 * number could actively mislead. `pending` is carried alongside so a caller can say what the rate
 * is still waiting on.
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
 * What `Application.requirementEvidence` says across a set of postings — the per-requirement
 * verdicts already computed and persisted at save time, read back in aggregate for the first time.
 *
 * Strictly better than the keyword coverage beside it for the same reason `requirementEvidence.ts`
 * exists at all: coverage answers "does this term appear in my profile", this answers "does the
 * resume I actually sent evidence what the posting actually asked for" — and it distinguishes
 * `omitted-profile-evidence`, the one verdict that names a fixable mistake rather than a missing
 * skill. That bullet was in the Profile and this resume dropped it.
 *
 * **Counted over scored postings only.** `requirementEvidence` is `null` for every row saved before
 * the field existed and for any row whose Profile could not be read at save time, and nothing
 * backfills one. `unscoredPostings` carries that count so a caller states the denominator rather
 * than quietly reporting a rate over whichever rows happened to have the field — the same rule
 * `requirementKindCounts` follows for `unspecified`.
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
 * One application's stored verdicts, keyed by the requirement's own text so the requirements list
 * can badge a row it is already rendering.
 *
 * Text is the only key available: `requirementEvidence` stores a copy of the `JobRequirement` it
 * scored rather than an index into `jobInfo.requirements`, and the two arrays are written in the
 * same transaction from the same source, so a row whose text matches is that row. A posting that
 * genuinely repeats a requirement verbatim collapses to one entry — harmless, since both would
 * carry the same verdict.
 *
 * Returns an empty map for an unscored row, so callers badge nothing rather than branching.
 */
export function evidenceByRequirement(
  application: Application,
): Map<string, RequirementEvidenceEntry> {
  return new Map(
    (application.requirementEvidence ?? []).map((entry) => [entry.requirement.text, entry]),
  );
}

/**
 * What `Analytics.tsx` filters `applications` by before reporting anything — range, stage, and the
 * two keyword-table toggles. Grouped into one argument because every field below is drawn from this
 * same filter state; splitting them into separate parameters would just make the call site repeat
 * this list of names as `analyticsReport(applications, range, stage, today, …)`.
 */
export interface AnalyticsReportFilters {
  range: Range;
  stage: StageFilter | null;
  /** "Now," as the view pinned it — see {@link rangeStart}'s own note on why the clock isn't read here. */
  asOf: Date;
  /** Keeps a keyword row only once at least this many postings in range asked for it. */
  minAppearances: number;
  /** Narrows `rows` further to keywords `profile` doesn't evidence — a no-op without one. */
  gapsOnly: boolean;
  /** `null` while no Profile is available yet; coverage (and so `gapsOnly`) is skipped entirely. */
  profile: Profile | null;
}

/**
 * Everything the Analytics view renders from one filtered look at `applications` — the range,
 * stage and keyword-table toggle interaction that used to live as eight chained `useMemo` calls in
 * `Analytics.tsx` itself, untested at that boundary because nothing sat behind an interface a test
 * could call directly. One filter argument in, one report out; the view's own `useMemo` wraps this
 * single call instead of each field inside it.
 */
export interface AnalyticsReport {
  rangeStartDate: Date;
  /** Every application in range, before the stage filter — what the stage pills count against. */
  inRange: Application[];
  /** In range and matching the stage filter — the population every field below is drawn from. */
  filtered: Application[];
  /** Every keyword `filtered` asked for, before `minAppearances`/`gapsOnly` narrow it to `rows`. */
  frequency: KeywordFrequencyRow[];
  /** `frequency`, narrowed by `minAppearances` and, when set, `gapsOnly` — what the table renders. */
  rows: KeywordFrequencyRow[];
  /** `null` until `filters.profile` is given. */
  coverageByTerm: Map<string, CoverageVerdict> | null;
  /** How many of `frequency` (not `rows`) are gaps — the summary strip's count regardless of the toggle. */
  gapCount: number;
  /** `null` when `filters.stage` narrows the population — see {@link responseRate}'s own caution. */
  baseline: ResponseRate | null;
}

export function analyticsReport(
  applications: Application[],
  filters: AnalyticsReportFilters,
): AnalyticsReport {
  const rangeStartDate = rangeStart(filters.range, filters.asOf);
  const inRange = applications.filter(
    (application) => new Date(application.createdAt) >= rangeStartDate,
  );
  const filtered = filters.stage
    ? inRange.filter((application) => stageFilterOf(application.stage) === filters.stage)
    : inRange;

  const frequency = keywordFrequency(filtered);
  const coverageByTerm = filters.profile ? coverageForKeywords(frequency, filters.profile) : null;
  const gapCount = coverageByTerm
    ? frequency.filter((row) => coverageByTerm.get(row.term) === 'missing').length
    : 0;
  // `gapsOnly` with no `coverageByTerm` to check against (the caller has no Profile yet) hides
  // every row rather than showing all of them — nothing can be confirmed a gap without something
  // to score it against, so nothing is shown as one. The view keeps this state unreachable by
  // disabling the toggle until a Profile has loaded; the report still has to answer it sanely.
  const rows = frequency
    .filter((row) => !filters.gapsOnly || coverageByTerm?.get(row.term) === 'missing')
    .filter((row) => row.count >= filters.minAppearances);

  // Suppressed entirely while a stage filter is on — see `responseRate`'s own note: a population
  // selected on the outcome being measured reports a rate that isn't one.
  const baseline = filters.stage === null ? responseRate(filtered) : null;

  return { rangeStartDate, inRange, filtered, frequency, rows, coverageByTerm, gapCount, baseline };
}

/**
 * Everything `RequirementsPanel` renders for one keyword selection — the same filter/roll-up chain
 * that used to live inline in the component, called on every render with nothing behind an
 * interface a test could reach without mounting it.
 */
export interface RequirementsReport {
  /** `applications`, narrowed to postings that asked for the selected keyword — or all, if none. */
  matching: Application[];
  /** `matching`, newest first — what the panel actually lists. */
  sorted: Application[];
  requirementCounts: RequirementKindCounts;
  bandCounts: RequirementImportanceCounts;
  /** Whether anything in `matching` carries an importance band at all — see `RequirementImportanceCounts`. */
  anyBanded: boolean;
  yearsDistribution: YearsOfExperienceCount[];
  evidence: RequirementEvidenceRollup;
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
  const sorted = [...matching].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const requirementCounts = requirementKindCounts(matching);
  const bandCounts = requirementImportanceCounts(matching);
  const anyBanded = bandCounts.total > bandCounts.unbanded;
  const yearsDistribution = yearsOfExperienceDistribution(matching);
  const evidence = requirementEvidenceRollup(matching);

  return {
    matching,
    sorted,
    requirementCounts,
    bandCounts,
    anyBanded,
    yearsDistribution,
    evidence,
  };
}
