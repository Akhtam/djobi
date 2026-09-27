import { useRef, useState } from 'react';
import { parseProfile, type ExtractedProfile, type Profile } from '@djobi/shared';
import { applyExtractedProfile, normalizeProfileDraft } from './profileDraft.js';

/**
 * What a completed {@link ProfileDraft.save} did. `error` is unclassified: each app handles a 401
 * its own way.
 */
export type ProfileSaveOutcome =
  { kind: 'saved' } | { kind: 'stale' } | { kind: 'error'; error: unknown };

/** What a completed {@link ProfileDraft.applyResume} did; `error` unclassified as above. */
export type ProfileExtractOutcome =
  { kind: 'parsed' } | { kind: 'stale' } | { kind: 'error'; error: unknown };

/**
 * The editable Profile draft and its save protocol: capture the edit revision, normalize, persist,
 * drop a response an edit has superseded, load what came back. Loading the first Profile is the
 * caller's job.
 */
export interface ProfileDraft {
  /** The current draft, or `null` before the first {@link load}. */
  profile: Profile | null;
  /** True once an edit has been made since the last {@link load}. */
  dirty: boolean;
  /** True while a {@link save} is in flight — the form stays editable throughout. */
  saving: boolean;
  /** True while an {@link applyResume} is parsing — the form stays editable throughout. */
  extracting: boolean;
  /** Applies a candidate's edit: updates the draft and marks it dirty. */
  setProfile(next: Profile): void;
  /** Replaces the draft without marking it dirty — for a fresh load. */
  load(next: Profile): void;
  /**
   * Normalizes and persists the draft, applying the response unless an edit landed meanwhile
   * (`stale`). On error the draft is untouched. Before the first {@link load}: no-op, `stale`.
   */
  save(persist: (profile: Profile) => Promise<Profile>): Promise<ProfileSaveOutcome>;
  /**
   * Runs `extract` on `file` and applies the result onto the draft as it is *when parsing returns*
   * (so edits made while waiting survive), marking it dirty. Persists nothing. Before the first
   * {@link load}: no-op, `stale`.
   */
  applyResume(
    file: File,
    extract: (file: File) => Promise<ExtractedProfile>,
  ): Promise<ProfileExtractOutcome>;
}

export function useProfileDraft(): ProfileDraft {
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  // Refs, not state: read after an `await` in `save`, where a state closure would be stale.
  const revisionRef = useRef(0);
  const profileRef = useRef<Profile | null>(null);

  function setProfile(next: Profile) {
    // A no-op edit (e.g. adding a blank skill) returns the same reference rather than a copy —
    // skip the dirty/revision bump so the form doesn't claim unsaved changes for nothing.
    if (next === profileRef.current) return;
    ++revisionRef.current;
    profileRef.current = next;
    setProfileState(next);
    setDirty(true);
  }

  function load(next: Profile) {
    profileRef.current = next;
    setProfileState(next);
    setDirty(false);
  }

  async function save(
    persist: (profile: Profile) => Promise<Profile>,
  ): Promise<ProfileSaveOutcome> {
    const current = profileRef.current;
    if (!current) return { kind: 'stale' };

    const revision = revisionRef.current;
    setSaving(true);
    try {
      const saved = await persist(normalizeProfileDraft(current, () => crypto.randomUUID()));
      // The form remains editable while saving. Do not replace newer edits with the snapshot
      // returned for an older request.
      if (revisionRef.current !== revision) return { kind: 'stale' };
      // `parseProfile` completes a stored profile against the empty one and validates it, so a
      // profile saved before a field existed can't crash the form that binds to that key.
      load(parseProfile(saved));
      return { kind: 'saved' };
    } catch (error: unknown) {
      return { kind: 'error', error };
    } finally {
      setSaving(false);
    }
  }

  async function applyResume(
    file: File,
    extract: (file: File) => Promise<ExtractedProfile>,
  ): Promise<ProfileExtractOutcome> {
    if (!profileRef.current) return { kind: 'stale' };

    setExtracting(true);
    try {
      const extracted = await extract(file);
      // Re-read rather than closing over the value checked above: the form stayed editable while
      // the resume was parsing, and `.current` is the only reading that includes those edits.
      const current = profileRef.current;
      if (!current) return { kind: 'stale' };
      setProfile(applyExtractedProfile(current, extracted));
      return { kind: 'parsed' };
    } catch (error: unknown) {
      return { kind: 'error', error };
    } finally {
      setExtracting(false);
    }
  }

  return { profile, dirty, saving, extracting, setProfile, load, save, applyResume };
}
