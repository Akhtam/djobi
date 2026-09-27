import type { ReactNode } from 'react';

/**
 * A list section's outer wrapper, heading and item count (the extension uses a `<fieldset>` with a
 * count; the dashboard a `<section>` without).
 */
export type ListSectionRenderer = (props: {
  id: string;
  legend: string;
  hint?: string | undefined;
  /** `items.length` — the extension shows it; the dashboard's own renderer ignores it. */
  itemCount: number;
  children: ReactNode;
}) => ReactNode;

/**
 * One entry's wrapper: numbering, Remove button and the pre-rendered `summary` (a collapsible
 * `<details>` in the extension, a plain paragraph in the dashboard).
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
 * What a `ListSection` needs from its caller. Elements that differ only by class name take a
 * string, not a renderer.
 */
export interface ListSectionChrome {
  Section: ListSectionRenderer;
  Entry: ListSectionEntryRenderer;
  emptyClassName: string;
  addButtonClassName: string;
}
