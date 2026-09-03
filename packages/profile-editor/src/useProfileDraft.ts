import { useRef, useState } from 'react';
import type { Profile } from '@djobi/shared';

/**
 * The editable Profile draft: what a candidate is looking at before it's saved, plus enough
 * bookkeeping to answer "has anything changed since I started this save."
 *
 * Loading and saving themselves stay with the caller — this hook knows nothing about a
 * `DashboardClient`/`BackendClient` or a 401. What it owns is the one invariant both apps had
 * hand-rolled identically: an edit made while a save is in flight must not be silently overwritten
 * by that save's own response landing after it. See {@link isStale}.
 */
export interface ProfileDraft {
  /** The current draft, or `null` before the first {@link load}. */
  profile: Profile | null;
  /** True once an edit has been made since the last {@link load}. */
  dirty: boolean;
  /** Applies a candidate's edit: updates the draft and marks it dirty. */
  setProfile(next: Profile): void;
  /**
   * Replaces the draft without marking it dirty — for a fresh load, or the record a successful
   * save returned. A save's result should only be applied when {@link isStale} says it wasn't
   * superseded by a later edit; see that method.
   */
  load(next: Profile): void;
  /**
   * Captures the current edit revision, to check later with {@link isStale} — call this before
   * starting a save, not after it resolves.
   */
  captureRevision(): number;
  /**
   * True if an edit has landed since `revision` was captured — i.e. this save's result is stale
   * and applying it via {@link load} would discard a newer, unsaved edit.
   */
  isStale(revision: number): boolean;
}

export function useProfileDraft(): ProfileDraft {
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [dirty, setDirty] = useState(false);
  // A ref, not state: `isStale` is read inside an async handler after an `await`, where a stale
  // closure over a state value would still show the revision as of when the handler was created,
  // not the latest one. `.current` always answers with the truth as of the read.
  const revisionRef = useRef(0);

  function setProfile(next: Profile) {
    ++revisionRef.current;
    setProfileState(next);
    setDirty(true);
  }

  function load(next: Profile) {
    setProfileState(next);
    setDirty(false);
  }

  function captureRevision(): number {
    return revisionRef.current;
  }

  function isStale(revision: number): boolean {
    return revisionRef.current !== revision;
  }

  return { profile, dirty, setProfile, load, captureRevision, isStale };
}
