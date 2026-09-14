import type { ReactNode } from 'react';
import type { ListEditor } from './listEditing.js';
import type { ListSectionChrome } from './listSectionChrome.js';

/**
 * The chrome around one editable list: a section, a numbered removable entry per item, and an Add
 * button — the list-level counterpart to `profileFieldBodies.tsx`'s field bodies.
 *
 * Both apps used to hand-roll this identically down to the prop names, differing only in how much
 * of the presentation `chrome` now owns: the extension shows an item count and collapses an
 * entry's fields behind its `summary`; the dashboard shows neither. What was actually shared —
 * entry numbering, the Remove button's wiring, the empty-state message, the Add button — now lives
 * here exactly once; what genuinely differs stays behind `chrome`, mirroring `FieldChrome`.
 */
export function ListSection<T>({
  chrome,
  id,
  legend,
  noun,
  addLabel,
  hint,
  items,
  editor,
  controls,
  summary,
  children,
}: {
  chrome: ListSectionChrome;
  id: string;
  legend: string;
  noun: string;
  addLabel: string;
  hint?: string;
  items: T[];
  editor: ListEditor<T>;
  controls?: ReactNode;
  summary?: (entry: T, index: number) => ReactNode;
  children: (entry: T, index: number) => ReactNode;
}) {
  const { Section, Entry, emptyClassName, addButtonClassName } = chrome;

  return (
    <Section id={id} legend={legend} hint={hint} itemCount={items.length}>
      {controls}
      {items.length === 0 && <p className={emptyClassName}>No {noun} added yet.</p>}
      {items.map((entry, index) => (
        <Entry
          key={index}
          index={index}
          noun={noun}
          onRemove={() => editor.remove(index)}
          summary={summary?.(entry, index)}
        >
          {children(entry, index)}
        </Entry>
      ))}
      <button type="button" className={addButtonClassName} onClick={editor.add}>
        {addLabel}
      </button>
    </Section>
  );
}
