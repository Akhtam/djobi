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
  normalizeLabel,
  type Application,
  type KeywordCategory,
  type RequirementKind,
} from '@djobi/shared';

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
 * Every keyword `applications` extracted, grouped by {@link normalizeLabel} so `K8s` and
 * `Kubernetes` do not become two rows nothing can merge — though the extraction prompt collapsing
 * synonyms at the source is the real fix; this only prevents case/whitespace variants of the same
 * canonical name from splitting. Sorted by count descending, alphabetical tie-break so ordering is
 * stable across renders.
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
      const normalized = normalizeLabel(keyword.term);
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

/** One point of {@link yearsOfExperienceDistribution} — how many requirements stated `years`. */
export interface YearsOfExperienceCount {
  years: number;
  count: number;
}

/**
 * How often each stated `yearsOfExperience` value appears across `applications`, ascending by
 * years. Requirements with no stated figure — the common case — are excluded rather than counted
 * under a `null` bucket: this reports the distribution of what postings *did* state, not a census
 * of what they left silent.
 */
export function yearsOfExperienceDistribution(
  applications: Application[],
): YearsOfExperienceCount[] {
  const counts = new Map<number, number>();
  for (const application of applications) {
    for (const requirement of application.jobInfo.requirements) {
      if (requirement.yearsOfExperience === null) continue;
      counts.set(
        requirement.yearsOfExperience,
        (counts.get(requirement.yearsOfExperience) ?? 0) + 1,
      );
    }
  }
  return [...counts.entries()]
    .map(([years, count]) => ({ years, count }))
    .sort((a, b) => a.years - b.years);
}
