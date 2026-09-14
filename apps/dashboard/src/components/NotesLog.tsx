/**
 * An application's notes, newest first, filterable by category.
 *
 * Newest first because the reason to open this log is usually "what happened in the last
 * conversation".
 *
 * **Delete yes, edit no**, and the asymmetry is deliberate. The log is append-only against
 * *concurrent* writes — two notes added close together must not overwrite one another, which is why
 * the backend appends in SQL — but that rule is about not losing entries by accident, not about
 * refusing a candidate who says a note never belonged there. A note rewritten in place is history
 * that can no longer be trusted; a note removed is one the candidate has said was a mistake. So
 * removal is offered and editing is not.
 *
 * Removal is two clicks, never one. This log is read months after it is written, an accidental
 * delete has nothing to recover from, and the delete is a network write that can fail — see
 * `useApplicationStore.deleteNote` for how a failed one puts the note back where it was.
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
  /**
   * Removes one note. Optional, so a caller with nothing to write to — a read-only rendering of a
   * log — gets no delete affordance rather than a button that cannot work.
   */
  onDelete?: (noteId: string) => void;
}) {
  const [category, setCategory] = useState<NoteCategory | null>(null);
  // One id, not a set: arming a second note disarms the first, because two live "are you sure"
  // prompts in one list is two chances to confirm the wrong one.
  const [armed, setArmed] = useState<string | null>(null);

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
                      // Named by which note it deletes: every row's button would otherwise be called
                      // "Delete note", which is unusable by anyone reading the page through its
                      // accessibility tree rather than its layout.
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
