/**
 * A real `<select>` painted to look like whatever the caller needs: a visible value and a caret,
 * with the actual `<select>` laid over both of them invisibly so the browser's own picker,
 * keyboard support and focus handling all still work. A select's rendered value can't be styled
 * consistently across browsers, which is why the visible half is a sibling rather than the
 * select's own text.
 *
 * Extracted from `StageSelect` once `Analytics.tsx`'s date-range control needed the identical
 * three-layer trick under a different skin — a bordered pill instead of a stage badge. One
 * implementation now, so a fix to the overlay sizing, the caret's stroke, or the focus ring has to
 * land once rather than in both places and risk drifting the way two copies of the same markup do.
 *
 * Purely structural: every class name is the caller's own, so `StageSelect`'s fixed-width colored
 * badge and Analytics' compact bordered pill can look nothing alike while sharing this underneath.
 */
export function FakeSelect<T extends string>({
  value,
  options,
  labels,
  ariaLabel,
  onChange,
  className,
  valueClassName,
  caretClassName,
  selectClassName,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  ariaLabel: string;
  onChange: (value: T) => void;
  /** The outer element's class — the caller's whole visual skin lives here and below. */
  className: string;
  valueClassName: string;
  caretClassName: string;
  /** The invisible, absolutely-positioned real `<select>`'s own class. */
  selectClassName: string;
}) {
  return (
    <span className={className}>
      <span className={valueClassName}>{labels[value]}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" className={caretClassName}>
        <path d="m6 9 6 6 6-6" />
      </svg>
      <select
        className={selectClassName}
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </span>
  );
}
