import type { ReactNode } from 'react';

/**
 * One labeled control's outer chrome — the part that genuinely differs between the two Profile
 * surfaces (a `<div className="field">` plus an explicit `<label htmlFor>` in the extension's
 * options page; a single wrapping `<label>` with no `id` in the dashboard's account-profile page).
 * Every field body in `profileFieldBodies.tsx` renders through this rather than choosing its own
 * wrapper, so the two apps keep their own markup while sharing everything else about a field —
 * its value, its `onChange`, its `type`, its autocomplete hint.
 *
 * `id` is supplied on every call, even though the dashboard's own renderer has nothing to do with
 * it (its label wraps the control implicitly, needing no `htmlFor`) — a field body sets the same
 * `id` on the control itself either way, so the extension's `htmlFor` always has something to
 * point at without the two renderers needing different signatures.
 */
export type FieldRenderer = (props: {
  id: string;
  label: string;
  /** Two grid columns instead of one — the long free-text fields (descriptions, bullets). */
  span2?: boolean;
  children: ReactNode;
}) => ReactNode;

/**
 * A checkbox's outer chrome. Both apps wrap one the same way — a label around the checkbox and its
 * own text — differing only in the wrapper's class name, so this stays a renderer rather than a
 * `controlClassName`-style flag: the label text sits *inside* the wrapper, unlike every other field.
 */
export type CheckboxFieldRenderer = (props: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => ReactNode;

/**
 * What a field body needs from its caller to render — one bundle rather than three separate props,
 * since every field body in this package takes the same three.
 */
export interface FieldChrome {
  Field: FieldRenderer;
  Checkbox: CheckboxFieldRenderer;
  /**
   * Applied to every `<input>`/`<select>`/`<textarea>` a field body renders. The dashboard's `search`
   * class lives here; the extension passes `undefined` and styles inputs by their `.field`
   * ancestor instead. Never applied to a checkbox — see {@link CheckboxFieldRenderer}, whose own
   * wrapper carries the styling hook instead.
   */
  controlClassName?: string;
}

/**
 * Class names for a work-experience or project entry's bullet list — the one widget in this
 * package that is not itself a labeled field, so it does not fit {@link FieldRenderer}. Each name
 * is optional because a project's bullets have no star button; a work entry's do.
 */
export interface BulletListClassNames {
  list?: string;
  row?: string;
  starButton?: string;
  removeButton?: string;
  addButton?: string;
}
