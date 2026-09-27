/**
 * A real `<select>` laid invisibly over a styled value and caret, so the browser's picker, keyboard
 * and focus handling still work while the look is custom. Purely structural — class names are the
 * caller's (`StageSelect`'s badge, Analytics' range pill).
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
