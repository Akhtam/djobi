/**
 * The always-visible note composer.
 *
 * Not hidden behind an "Add note" button: recording what an interview asked is the main reason to
 * open an application, so the affordance for it should not cost a click to reveal.
 */
import { useState } from 'react';
import type { NewNote, NoteCategory } from '@djobi/shared';
import { NOTE_CATEGORIES, NOTE_CATEGORY_LABELS } from '../lib/stages';

export function AddNoteForm({ onAdd }: { onAdd: (note: NewNote) => Promise<boolean> }) {
  const [category, setCategory] = useState<NoteCategory>('general');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const trimmed = text.trim();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || saving) return;

    setSaving(true);
    try {
      // Clearing unconditionally would throw the user's typing away on every failure: a rejected
      // write is handled inside the store, so awaiting this tells you nothing unless it says so.
      // A stopped backend is the everyday case here, and losing a paragraph of interview notes to
      // it would be the worst failure this screen has.
      const added = await onAdd({ category, text: trimmed });
      // Only the text clears. The category is far more likely to repeat than to change — three
      // notes from one interview are usually all `technical`.
      if (added) setText('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="add-note" onSubmit={(event) => void onSubmit(event)}>
      <div className="add-note__categories" role="group" aria-label="Note category">
        {NOTE_CATEGORIES.map((option) => (
          <label
            key={option}
            className={`add-note__category ${category === option ? 'is-selected' : ''}`}
          >
            <input
              type="radio"
              name="note-category"
              value={option}
              checked={category === option}
              onChange={() => setCategory(option)}
            />
            {NOTE_CATEGORY_LABELS[option]}
          </label>
        ))}
      </div>
      <div className="add-note__row">
        <textarea
          className="add-note__text"
          aria-label="Note"
          placeholder="What happened? What did they ask?"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="button button--primary" disabled={!trimmed || saving}>
          {saving ? 'Adding…' : 'Add note'}
        </button>
      </div>
    </form>
  );
}
