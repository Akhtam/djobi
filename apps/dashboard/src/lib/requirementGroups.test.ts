import type { JobRequirement, RequirementImportance } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { groupByImportance, ROW_BUDGET } from './requirementGroups';

function requirement(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    text: 'Some requirement',
    kind: 'unspecified',
    yearsOfExperience: null,
    importance: null,
    importanceTier: null,
    postingSignal: null,
    ...overrides,
  };
}

function many(count: number, importance: RequirementImportance): JobRequirement[] {
  return Array.from({ length: count }, (_, index) =>
    requirement({ text: `${importance} ${index}`, importance }),
  );
}

describe('groupByImportance', () => {
  it('orders the groups most decisive first, with the unassessed last', () => {
    const { groups } = groupByImportance([
      requirement({ text: 'unassessed' }),
      requirement({ text: 'low', importance: 'low-signal' }),
      requirement({ text: 'critical', importance: 'critical' }),
      requirement({ text: 'preferred', importance: 'preferred' }),
      requirement({ text: 'high', importance: 'high' }),
      requirement({ text: 'meaningful', importance: 'meaningful' }),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      'critical',
      'high',
      'meaningful',
      'preferred',
      'low-signal',
      'unbanded',
    ]);
  });

  it('omits a band no requirement fell into', () => {
    const { groups } = groupByImportance([requirement({ importance: 'high' })]);

    expect(groups.map((group) => group.key)).toEqual(['high']);
  });

  it('keeps the posting order within one band', () => {
    const { groups } = groupByImportance([
      requirement({ text: 'first', importance: 'high' }),
      requirement({ text: 'second', importance: 'high' }),
      requirement({ text: 'third', importance: 'high' }),
    ]);

    expect(groups[0]!.requirements.map((entry) => entry.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('trims past the budget from the lowest band, and says how many it dropped', () => {
    const { groups, hiddenCount } = groupByImportance([
      ...many(2, 'critical'),
      ...many(8, 'meaningful'),
      ...many(6, 'low-signal'),
    ]);

    const shown = groups.flatMap((group) => group.requirements);

    expect(shown).toHaveLength(ROW_BUDGET);
    expect(hiddenCount).toBe(4);
    expect(groups.map((group) => group.key)).toEqual(['critical', 'meaningful', 'low-signal']);
    expect(shown.filter((entry) => entry.importance === 'low-signal')).toHaveLength(2);
  });

  it('keeps every critical and high row even when that breaks the budget', () => {
    const { groups, hiddenCount } = groupByImportance([
      ...many(10, 'critical'),
      ...many(9, 'high'),
      ...many(5, 'meaningful'),
    ]);

    const shown = groups.flatMap((group) => group.requirements);

    expect(shown.filter((entry) => entry.importance === 'critical')).toHaveLength(10);
    expect(shown.filter((entry) => entry.importance === 'high')).toHaveLength(9);
    expect(shown.filter((entry) => entry.importance === 'meaningful')).toHaveLength(0);
    expect(hiddenCount).toBe(5);
  });

  it('hides nothing when the list is already within the budget', () => {
    const { groups, hiddenCount } = groupByImportance(many(ROW_BUDGET, 'meaningful'));

    expect(groups.flatMap((group) => group.requirements)).toHaveLength(ROW_BUDGET);
    expect(hiddenCount).toBe(0);
  });

  it('renders a wholly unassessed posting in full, however long it is', () => {
    const requirements = Array.from({ length: 30 }, (_, index) =>
      requirement({ text: `legacy ${index}` }),
    );

    const { groups, hiddenCount } = groupByImportance(requirements);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.requirements).toHaveLength(30);
    expect(hiddenCount).toBe(0);
  });

  it('trims the unassessed tail once anything in the posting carries a band', () => {
    const { groups, hiddenCount } = groupByImportance([
      ...many(2, 'critical'),
      ...Array.from({ length: 20 }, (_, index) => requirement({ text: `legacy ${index}` })),
    ]);

    expect(groups.flatMap((group) => group.requirements)).toHaveLength(ROW_BUDGET);
    expect(hiddenCount).toBe(10);
  });

  it('returns nothing for a posting with no requirements', () => {
    expect(groupByImportance([])).toEqual({ groups: [], hiddenCount: 0 });
  });
});
