import type { ReactNode } from 'react';

/**
 * The list-editor shell's outer chrome — one section's card/panel, its heading, and its item count.
 *
 * The two apps genuinely differ here, not just in class names: the extension wraps the whole
 * section in a `<fieldset>` with the count shown beside the hint; the dashboard wraps it in a
 * `<section>` with no count at all. A renderer that wraps `children` — mirroring {@link
 * FieldRenderer}'s own shape — is what lets each app keep that difference rather than one of them
 * losing it to a shared markup shape neither fully wanted.
 */
export type ListSectionRenderer = (props: {
  id: string;
  legend: string;
  hint?: string;
  /** `items.length` — the extension shows it; the dashboard's own renderer ignores it. */
  itemCount: number;
  children: ReactNode;
}) => ReactNode;

/**
 * One entry's outer chrome — its own numbering, its Remove button, and whatever the caller's
 * `summary` renders.
 *
 * This is where the two apps diverge furthest: the extension wraps an entry with a `summary` in a
 * collapsible native `<details>`, with the summary text as the disclosure's own clickable label;
 * the dashboard renders the same summary as a plain, always-visible paragraph above the entry's
 * fields. `summary` arrives already rendered (not the raw function `ListSection` was given, plus
 * the entry and index) — this renderer only ever needs to place it, never to compute it.
 */
export type ListSectionEntryRenderer = (props: {
  index: number;
  /** What one entry is called, singular — for the Remove button's own accessible name. */
  noun: string;
  onRemove: () => void;
  summary?: ReactNode;
  children: ReactNode;
}) => ReactNode;

/**
 * What a `ListSection` needs from its caller to render — the list-level counterpart to {@link
 * FieldChrome}. `emptyClassName`/`addButtonClassName` stay plain strings rather than renderers,
 * the same way {@link FieldChrome.controlClassName} does: a `<p>`/`<button>` whose only difference
 * between apps is its class name doesn't earn a wrapping function.
 */
export interface ListSectionChrome {
  Section: ListSectionRenderer;
  Entry: ListSectionEntryRenderer;
  emptyClassName: string;
  addButtonClassName: string;
}
