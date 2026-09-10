/**
 * `RequirementList` rendering the importance grouping and its row budget.
 *
 * The budget's arithmetic is pinned in `lib/requirementGroups.test.ts`, against the pure function.
 * What is tested here is what the reader actually sees: which headings appear, that a trimmed list
 * says so on screen rather than silently ending, that the trimmed rows can be revealed, and that a
 * posting extracted before importance existed still renders every row it always did.
 */
import type { JobRequirement, RequirementImportance } from '@djobi/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RequirementList } from './RequirementList';
import { ROW_BUDGET } from '../lib/requirementGroups';

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

function many(count: number, importance: RequirementImportance | null): JobRequirement[] {
  return Array.from({ length: count }, (_, index) =>
    requirement({ text: `${importance ?? 'legacy'} ${index}`, importance }),
  );
}

function renderList(requirements: JobRequirement[]) {
  return render(<RequirementList requirements={requirements} evidence={new Map()} />);
}

function headings(): string[] {
  return screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent ?? '');
}

describe('RequirementList', () => {
  it('heads each group with its band, most decisive first and the unassessed last', () => {
    renderList([
      requirement({ text: 'unassessed' }),
      requirement({ text: 'low', importance: 'low-signal' }),
      requirement({ text: 'critical', importance: 'critical' }),
      requirement({ text: 'high', importance: 'high' }),
    ]);

    expect(headings()).toEqual(['critical', 'high', 'low signal', 'not assessed']);
  });

  it('says how many rows the budget dropped instead of quietly ending the list', () => {
    renderList([...many(2, 'critical'), ...many(8, 'meaningful'), ...many(6, 'low-signal')]);

    expect(screen.getAllByRole('listitem')).toHaveLength(ROW_BUDGET);
    expect(screen.getByText('Show 4 more requirements')).toBeInTheDocument();
  });

  it('says "requirement" rather than "requirements" when exactly one row was dropped', () => {
    renderList([...many(2, 'critical'), ...many(11, 'meaningful')]);

    expect(screen.getByText('Show 1 more requirement')).toBeInTheDocument();
  });

  it('reveals every trimmed row on request, since this screen is the only place they appear', async () => {
    renderList([...many(2, 'critical'), ...many(8, 'meaningful'), ...many(6, 'low-signal')]);

    await userEvent.click(screen.getByRole('button', { name: 'Show 4 more requirements' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(16);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it('shows every decisive row even when keeping them breaks the budget', () => {
    renderList([...many(10, 'critical'), ...many(9, 'high'), ...many(5, 'meaningful')]);

    expect(screen.getAllByRole('listitem')).toHaveLength(19);
    expect(screen.getByText('critical 9')).toBeInTheDocument();
    expect(screen.getByText('high 8')).toBeInTheDocument();
    expect(screen.queryByText('meaningful 0')).not.toBeInTheDocument();
    expect(screen.getByText('Show 5 more requirements')).toBeInTheDocument();
  });

  it('renders a posting extracted before importance existed in full, and says nothing was trimmed', () => {
    renderList(many(30, null));

    expect(headings()).toEqual(['not assessed']);
    expect(screen.getAllByRole('listitem')).toHaveLength(30);
    expect(screen.queryByText(/not listed$/)).not.toBeInTheDocument();
  });

  it('adds no trimmed line when the list already fits', () => {
    renderList(many(3, 'meaningful'));

    expect(screen.queryByText(/not listed$/)).not.toBeInTheDocument();
  });
});
