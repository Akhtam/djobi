import { useRef, useState } from 'react';
import { parseProfile, type Profile } from '@djobi/shared';
import { normalizeProfileDraft } from './profileDraft.js';

/**
 * What a completed {@link ProfileDraft.save} did, for the caller to render.
 *
 * `error` carries the rejection unclassified on purpose: this module knows nothing about a 401,
 * and the two editors answer one differently — the options page swaps itself for the sign-in view,
 * the dashboard routes to `#/login`.
 */
export type ProfileSaveOutcome =
  { kind: 'saved' } | { kind: 'stale' } | { kind: 'error'; error: unknown };

/**
 * The editable Profile draft: what a candidate is looking at before it's saved, and the save
 * itself.
 *
 * Loading the *first* Profile stays with the caller — this hook knows nothing about a
 * `DashboardClient`/`BackendClient`. What it owns is the whole save protocol, which both apps had
 * hand-rolled identically and each had to get right in the same order: capture the edit revision,
 * normalize, persist, discard a response an edit has already superseded, load what came back. That
 * ordering used to be documented here and enforced nowhere; it is now {@link save}'s to keep.
 */
export interface ProfileDraft {
  /** The current draft, or `null` before the first {@link load}. */
  profile: Profile | null;
  /** True once an edit has been made since the last {@link load}. */
  dirty: boolean;
  /** True while a {@link save} is in flight — the form stays editable throughout. */
  saving: boolean;
  /** Applies a candidate's edit: updates the draft and marks it dirty. */
  setProfile(next: Profile): void;
  /**
   * Replaces the draft without marking it dirty — for a fresh load from the backend. A save's own
   * response is applied by {@link save}, not through here.
   */
  load(next: Profile): void;
  /**
   * Normalizes the draft, hands it to `persist`, and applies the record that comes back — unless
   * an edit landed while the request was out, in which case the response is dropped
   * (`{ kind: 'stale' }`) rather than silently discarding the newer edit. A rejection is reported
   * as `{ kind: 'error' }` with the draft untouched, so the candidate's work survives a retry.
   *
   * Calling this before the first {@link load} does nothing and reports `{ kind: 'stale' }` —
   * there is no draft to save.
   */
  save(persist: (profile: Profile) => Promise<Profile>): Promise<ProfileSaveOutcome>;
}

export function useProfileDraft(): ProfileDraft {
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Refs, not state: both are read inside `save` after an `await`, where a stale closure over a
  // state value would still show things as of when the handler was created, not the latest edit.
  // `.current` always answers with the truth as of the read.
  const revisionRef = useRef(0);
  const profileRef = useRef<Profile | null>(null);

  function setProfile(next: Profile) {
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

  return { profile, dirty, saving, setProfile, load, save };
}
