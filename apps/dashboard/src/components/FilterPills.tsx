/**
 * How many items fall under each option — the `counts` a {@link FilterPills} row renders.
 *
 * Lives beside the component that consumes it because both call sites (stages on the list, note
 * categories on the detail page) were writing the same `Object.fromEntries(...) as Record<T, …>`
 * by hand, cast included. The cast is unavoidable — `Object.fromEntries` widens the key back to
 * `string` — so it is worth having exactly once.
 */
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
 * A one-of-many filter row, shared by the list's stage filter and the detail page's note-category
 * filter. Generic over the option type so both keep their own enums rather than stringly-typing
 * through a shared component.
 *
 * `null` is the "All" option in both uses.
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
}) {
  return (
    <div className="filter-pills" role="group" aria-label={groupLabel}>
      <button
        type="button"
        className={`filter-pill ${selected === null ? 'is-selected' : ''}`}
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
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
          {labels[option]}
          {counts ? <span className="filter-pill__count">{counts[option]}</span> : null}
        </button>
      ))}
    </div>
  );
}
