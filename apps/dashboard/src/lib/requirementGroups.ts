/**
 * Grouping posting requirements by importance band, for the two views that show them.
 *
 * `RequirementList` (one application) and `RequirementsPanel` (every posting in a range) render the
 * same requirements against the same verdicts, so they must group them the same way. They used to
 * each carry their own required/preferred split, which is precisely the arrangement that drifts:
 * one screen gains a rule and the other silently disagrees with it. There is one helper now.
 *
 * **Why bands replace the required/preferred split rather than sitting inside it.** Two competing
 * priority orderings on one screen is not more information, it is a question the reader has to
 * resolve before they can read anything. `kind` is still stored and still means what it meant — how
 * the posting phrased the requirement — but the band is the stronger signal and it is the one that
 * orders the page.
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
 * Group order: the bands as `schemas.ts` declares them, with the unassessed last.
 *
 * Read off `IMPORTANCE_BANDS` rather than retyped, so this cannot drift from the sort in
 * `requirementEvidence.ts` — the two are the same ordering of the same facts, and a screen that
 * ranked them differently from the data would be the disagreement this module exists to prevent.
 *
 * `UNBANDED` sits at the end rather than being ranked among the bands because it is not a low band
 * — it is the absence of one. Most of the stored history predates importance, and placing those
 * requirements anywhere in the ranking would state a priority nobody assessed.
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

/**
 * The row budget. A long posting yields thirty requirements, and a thirty-row list is one nobody
 * reads to the end — the rows that matter are lost among the rows that do not, which defeats the
 * point of having ranked them.
 */
export const ROW_BUDGET = 12;

/**
 * Bands never trimmed, whatever the budget says — the same set the gate in
 * `requirementImportance.ts` refuses to let a guess reach. One concept, one definition: what
 * decides an application is what must not be hidden.
 */
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
 * `requirements` grouped by band, in band order, trimmed to {@link ROW_BUDGET}.
 *
 * Two rules govern the trim, and they can disagree:
 *
 * - **Every `critical` and `high` row survives**, even when keeping them pushes the list past the
 *   budget. A posting is allowed to state more than twelve must-haves, and a list that silently
 *   dropped one of them would hide exactly the row the reader opened the page for. The budget only
 *   ever trims `meaningful` and below.
 * - **The budget applies only when something was actually banded.** An application whose
 *   requirements all predate importance renders in full, exactly as it did before bands existed.
 *   An unassessed row must read as "nothing was checked", never as "nothing was found" — the same
 *   rule `RequirementList` already follows for a missing evidence verdict.
 *
 * Order within a group is the order the posting listed them; nothing is re-sorted here.
 *
 * `budget` exists for the one caller that offers a reveal: `RequirementList` passes `Infinity` once
 * the reader asks to see everything, so the same grouping renders untrimmed rather than a second
 * code path re-deriving it.
 *
 * One consequence worth naming: in a posting where *some* rows are banded, the unassessed tail is
 * the first thing trimmed, because it sorts last. That is the right call — a row nothing assessed
 * cannot outrank one assessed as `meaningful` — and it does not weaken the "nothing was checked"
 * reading, since the rows that survive still say `not assessed` and the count line says how many
 * did not.
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
