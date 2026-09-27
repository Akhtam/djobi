import type { ReactNode } from 'react';

/**
 * One labeled control's outer wrapper — the part that differs between surfaces (the extension uses
 * `<div class="field">` plus `<label htmlFor>`; the dashboard a wrapping `<label>`). Field bodies
 * render through this and always pass `id`, which they also set on the control.
 */
export type FieldRenderer = (props: {
  id: string;
  label: string;
  /** Two grid columns instead of one — the long free-text fields (descriptions, bullets). */
  span2?: boolean;
  children: ReactNode;
}) => ReactNode;

/**
 * A checkbox's wrapper: a label around the checkbox and its text. A renderer, not a class-name
 * flag, because the label text sits inside the wrapper.
 */
export type CheckboxFieldRenderer = (props: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => ReactNode;

/** What a field body needs from its caller to render. */
export interface FieldChrome {
  Field: FieldRenderer;
  Checkbox: CheckboxFieldRenderer;
  /**
   * Class for every rendered `<input>`/`<select>`/`<textarea>` (the dashboard's `search`); the
   * extension leaves it unset. Not applied to checkboxes.
   */
  controlClassName?: string;
}

/**
 * Class names for a work or project bullet list. Optional because project bullets have no star
 * button.
 */
export interface BulletListClassNames {
  list?: string;
  row?: string;
  starButton?: string;
  removeButton?: string;
  addButton?: string;
}
