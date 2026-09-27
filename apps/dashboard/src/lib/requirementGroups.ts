/**
 * Groups posting requirements by importance band for `RequirementList` (one application) and
 * `RequirementsPanel` (Analytics), so both order them identically. Bands replace the old
 * required/preferred split as the ordering; `kind` is still stored.
 */
import {
  DECISIVE_BANDS,
  IMPORTANCE_BANDS,
  type JobRequirement,
  type RequirementImportance,
} from '@djobi/shared';

/** The group a requirement carrying no band falls into. */
export const UNBANDED = 'unbanded' as const;

/** A band, or the bucket for requirements nothing has assessed. */
export type RequirementGroupKey = RequirementImportance | typeof UNBANDED;

/**
 * Group order: bands as declared in `schemas.ts` (so it matches `requirementEvidence.ts`'s sort),
 * then `UNBANDED` — not a low band but the absence of one.
 */
export const BAND_ORDER: readonly RequirementGroupKey[] = [...IMPORTANCE_BANDS, UNBANDED];

/** How each group is titled. `unbanded` says what it is rather than naming a band. */
export const BAND_LABELS: Record<RequirementGroupKey, string> = {
  critical: 'critical',
  high: 'high',
  meaningful: 'meaningful',
  preferred: 'preferred',
  'low-signal': 'low signal',
  [UNBANDED]: 'not assessed',
};

/** The row budget: a thirty-row list buries the rows that matter. */
export const ROW_BUDGET = 12;

/** Bands never trimmed — `DECISIVE_BANDS`, the ones the Importance Gate protects. */
function isDecisive(key: RequirementGroupKey): boolean {
  return key !== UNBANDED && DECISIVE_BANDS.has(key);
}

export interface RequirementGroup {
  key: RequirementGroupKey;
  requirements: JobRequirement[];
}

export interface GroupedRequirements {
  /** Non-empty groups, in {@link BAND_ORDER}, already trimmed to the budget. */
  groups: RequirementGroup[];
  /** Requirements the budget dropped — `0` whenever nothing was trimmed. */
  hiddenCount: number;
}

function keyOf(requirement: JobRequirement): RequirementGroupKey {
  return requirement.importance ?? UNBANDED;
}

/**
 * `requirements` grouped by band, in band order, trimmed to `budget`:
 *
 * - **Every `critical`/`high` row survives**, even past the budget; only `meaningful` and below are
 *   trimmed (the unassessed tail first, since it sorts last).
 * - **No budget if nothing is banded** — fully unassessed postings render in full.
 *
 * Posting order is kept within a group. `RequirementList` passes `Infinity` to reveal everything.
 */
export function groupByImportance(
  requirements: readonly JobRequirement[],
  budget: number = ROW_BUDGET,
): GroupedRequirements {
  const banded = requirements.some((requirement) => requirement.importance !== null);
  const ordered = BAND_ORDER.flatMap((key) => requirements.filter((r) => keyOf(r) === key));

  if (!banded || ordered.length <= budget) {
    return { groups: groupsOf(ordered), hiddenCount: 0 };
  }

  const kept = ordered.filter((requirement) => isDecisive(keyOf(requirement)));
  const trimmable = ordered.filter((requirement) => !isDecisive(keyOf(requirement)));
  const room = Math.max(budget - kept.length, 0);

  return {
    groups: groupsOf([...kept, ...trimmable.slice(0, room)]),
    hiddenCount: trimmable.length - Math.min(room, trimmable.length),
  };
}

function groupsOf(requirements: readonly JobRequirement[]): RequirementGroup[] {
  return BAND_ORDER.map((key) => ({
    key,
    requirements: requirements.filter((requirement) => keyOf(requirement) === key),
  })).filter((group) => group.requirements.length > 0);
}
