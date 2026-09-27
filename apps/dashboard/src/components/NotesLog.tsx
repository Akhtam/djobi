/**
 * An application's notes, newest first, filterable by category.
 *
 * **Delete yes, edit no.** Append-only is about concurrent writes never losing entries; a candidate
 * may still remove a note that never belonged, but an edited note is history that can't be trusted.
 * Deleting takes two clicks (it can't be undone) and a failed delete restores the note (see
 * `useApplicationStore.deleteNote`).
 */
import { useState } from 'react';
import type { Note, NoteCategory } from '@djobi/shared';
import { formatDateTime } from '../lib/format';
import { NOTE_CATEGORIES, NOTE_CATEGORY_LABELS } from '../lib/stages';
import { countByOption, FilterPills } from './FilterPills';

export function NotesLog({
  notes,
  onDelete,
}: {
  notes: Note[];
  /** Removes one note. Omit for a read-only log (no delete button). */
  onDelete?: (noteId: string) => void;
}) {
  const [category, setCategory] = useState<NoteCategory | null>(null);
  // One id, not a set: arming a second note disarms the first, because two live "are you sure"
  // prompts in one list is two chances to confirm the wrong one.
  const [armed, setArmed] = useState<string | null>(null);

  const newestFirst = notes.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
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
          No notes yet. Write down what they asked you — it's what you'll want before the next one.
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
                <div className="note__meta-actions">
                  <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
                  {onDelete && armed !== note.id ? (
                    <button
                      type="button"
                      className="note__delete note__delete--trigger"
                      // Name each button by its note, so screen-reader users can tell them apart.
                      aria-label={`Delete note from ${formatDateTime(note.createdAt)}`}
                      onClick={() => setArmed(note.id)}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="note__text">{note.text}</p>
              {onDelete && armed === note.id ? (
                <p className="note__confirm">
                  Delete this note?
                  <button
                    type="button"
                    className="note__delete note__delete--confirm"
                    onClick={() => {
                      setArmed(null);
                      onDelete(note.id);
                    }}
                  >
                    Yes, delete
                  </button>
                  <button type="button" className="note__delete" onClick={() => setArmed(null)}>
                    Keep it
                  </button>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
