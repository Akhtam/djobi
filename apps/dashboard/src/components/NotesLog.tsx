/**
 * An application's notes, newest first, filterable by category.
 *
 * Newest first because the reason to open this log is usually "what happened in the last
 * conversation". There is no edit or delete affordance, and there should not be one: the log is
 * append-only by product decision (see `CONTEXT.md`), so past interview questions stay usable as
 * preparation for the next application.
 */
import { useState } from 'react';
import type { Note, NoteCategory } from '@djobi/shared';
import { formatDateTime } from '../lib/format';
import { NOTE_CATEGORIES, NOTE_CATEGORY_LABELS } from '../lib/stages';
import { countByOption, FilterPills } from './FilterPills';

export function NotesLog({ notes }: { notes: Note[] }) {
  const [category, setCategory] = useState<NoteCategory | null>(null);

  const newestFirst = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visible = category ? newestFirst.filter((note) => note.category === category) : newestFirst;

  const counts = countByOption(NOTE_CATEGORIES, notes, (note) => note.category);

  return (
    <div className="notes-log">
      {notes.length > 0 ? (
        <FilterPills
          options={NOTE_CATEGORIES}
          labels={NOTE_CATEGORY_LABELS}
          selected={category}
          onSelect={setCategory}
          groupLabel="Filter notes by category"
          counts={counts}
        />
      ) : null}

      {notes.length === 0 ? (
        <p className="empty-hint">
          No notes yet. Record what they asked you — it is the reference for the next application.
        </p>
      ) : visible.length === 0 ? (
        <p className="empty-hint">No {NOTE_CATEGORY_LABELS[category!].toLowerCase()} notes.</p>
      ) : (
        <ul className="notes-log__list">
          {visible.map((note) => (
            <li key={note.id} className="note">
              <div className="note__meta">
                <span className={`note__category note__category--${note.category}`}>
                  {NOTE_CATEGORY_LABELS[note.category]}
                </span>
                <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
              </div>
              <p className="note__text">{note.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
