/**
 * Per-option counts for a {@link FilterPills} row. The `Record` cast (`Object.fromEntries` widens
 * the key) lives here once.
 */
import type { ReactNode } from 'react';

export function countByOption<Item, T extends string>(
  options: readonly T[],
  items: readonly Item[],
  optionOf: (item: Item) => T,
): Record<T, number> {
  const counts = Object.fromEntries(options.map((option) => [option, 0])) as Record<T, number>;
  for (const item of items) counts[optionOf(item)] += 1;
  return counts;
}

/**
 * A one-of-many filter row (list stage filter, detail note-category filter), generic over the
 * option type. `null` is "All".
 */
export function FilterPills<T extends string>({
  options,
  labels,
  selected,
  onSelect,
  allLabel = 'All',
  allCount,
  groupLabel,
  counts,
  renderIcon,
}: {
  options: readonly T[];
  labels: Record<T, string>;
  selected: T | null;
  onSelect: (value: T | null) => void;
  allLabel?: string;
  /** Optional count beside the All label. */
  allCount?: number;
  groupLabel: string;
  /** Optional per-option counts, rendered alongside the label. */
  counts?: Record<T, number>;
  /** Optional decorative icon rendered before each option's label. */
  renderIcon?: (value: T | null) => ReactNode;
}) {
  return (
    <div className="filter-pills" role="group" aria-label={groupLabel}>
      <button
        type="button"
        className={`filter-pill ${selected === null ? 'is-selected' : ''}`}
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        {renderIcon?.(null)}
        {allLabel}
        {allCount !== undefined ? <span className="filter-pill__count">{allCount}</span> : null}
      </button>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`filter-pill ${selected === option ? 'is-selected' : ''}`}
          aria-pressed={selected === option}
          onClick={() => onSelect(option)}
        >
          {renderIcon?.(option)}
          {labels[option]}
          {counts ? <span className="filter-pill__count">{counts[option]}</span> : null}
        </button>
      ))}
    </div>
  );
}
