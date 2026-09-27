import type { ReactNode, ReactElement } from 'react';
import type { ListEditor } from './listEditing.js';
import type { ListSectionChrome } from './listSectionChrome.js';

/**
 * One editable list: a section, a numbered removable entry per item, the empty state and an Add
 * button. Presentation differences (item count, collapsible entries) come from `chrome`.
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
  hint?: string | undefined;
  items: T[];
  editor: ListEditor<T>;
  controls?: ReactNode;
  summary?: (entry: T, index: number) => ReactNode;
  children: (entry: T, index: number) => ReactNode;
}): ReactElement {
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
