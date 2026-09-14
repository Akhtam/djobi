import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnauthorized, userMessage } from '@djobi/http-client';
import { EMPTY_PROFILE, parseProfile, type ExtractedProfile, type Profile } from '@djobi/shared';
import { addSkill } from './profileDraft.js';
import { useProfileDraft, type ProfileDraft } from './useProfileDraft.js';

/** The backend calls a Profile page needs. Each app adapts its own client to this. */
export interface ProfilePagePort {
  loadProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  extractResume(file: File): Promise<ExtractedProfile>;
}

export type ProfileSaveResult = { kind: 'saved' } | { kind: 'save-failed'; error: unknown };
export type ProfileUploadResult = { kind: 'parsed' } | { kind: 'parse-failed'; error: unknown };

/** Default wording for a save or upload result; both apps currently use it unchanged. */
export function profileOutcomeMessage(outcome: ProfileSaveResult | ProfileUploadResult): string {
  switch (outcome.kind) {
    case 'saved':
      return 'Profile saved.';
    case 'save-failed':
      return userMessage(outcome.error);
    case 'parsed':
      return 'Resume parsed. Review the pre-filled fields below, then save.';
    case 'parse-failed':
      return `Couldn't parse this resume: ${userMessage(outcome.error)}`;
  }
}

export interface ProfileWorkflow {
  draft: ProfileDraft;
  /** Why loading failed (the draft falls back to an empty Profile); cleared by a successful load or save. */
  loadError: unknown;
  saveResult: ProfileSaveResult | null;
  uploadResult: ProfileUploadResult | null;
  /** An edit — also retires a "Profile saved." result that no longer describes the form. */
  setProfile(next: Profile): void;
  uploadResume(file: File): Promise<void>;
  save(): Promise<void>;
  /** Loads the Profile again, e.g. after a fresh sign-in. */
  reload(): void;
  newSkill: string;
  setNewSkill(value: string): void;
  addNewSkill(): void;
}

/**
 * The Profile page workflow both editors share: first load with the empty fallback, resume upload,
 * save, and their results. A 401 from any of them goes to `onUnauthorized`; what that means — a
 * sign-in view or a redirect — is the app's.
 *
 * Reloads when `port` changes identity, so callers should memoize it.
 */
export function useProfileWorkflow(
  port: ProfilePagePort,
  onUnauthorized: () => void,
): ProfileWorkflow {
  const draft = useProfileDraft();
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveResult, setSaveResult] = useState<ProfileSaveResult | null>(null);
  const [uploadResult, setUploadResult] = useState<ProfileUploadResult | null>(null);
  const [newSkill, setNewSkill] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  // A ref so a caller passing a fresh callback each render doesn't trigger a reload.
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const { load } = draft;

  useEffect(() => {
    let current = true;
    port.loadProfile().then(
      (loaded) => {
        if (!current) return;
        setLoadError(null);
        load(parseProfile(loaded));
      },
      (error: unknown) => {
        if (!current) return;
        if (isUnauthorized(error)) {
          onUnauthorizedRef.current();
          return;
        }
        load(EMPTY_PROFILE);
        setLoadError(error);
      },
    );
    return () => {
      current = false;
    };
    // `load` is recreated every render but only writes state and refs, so it is not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, reloadCount]);

  function clearSavedResult() {
    setSaveResult((result) => (result?.kind === 'saved' ? null : result));
  }

  function setProfile(next: Profile) {
    draft.setProfile(next);
    clearSavedResult();
  }

  async function uploadResume(file: File) {
    setUploadResult(null);
    const outcome = await draft.applyResume(file, (upload) => port.extractResume(upload));
    if (outcome.kind === 'stale') return;
    if (outcome.kind === 'error') {
      if (isUnauthorized(outcome.error)) onUnauthorizedRef.current();
      else setUploadResult({ kind: 'parse-failed', error: outcome.error });
      return;
    }
    clearSavedResult();
    setUploadResult({ kind: 'parsed' });
  }

  async function save() {
    setSaveResult(null);
    const outcome = await draft.save((profile) => port.saveProfile(profile));
    if (outcome.kind === 'stale') return;
    if (outcome.kind === 'error') {
      if (isUnauthorized(outcome.error)) onUnauthorizedRef.current();
      else setSaveResult({ kind: 'save-failed', error: outcome.error });
      return;
    }
    setLoadError(null);
    setSaveResult({ kind: 'saved' });
  }

  function addNewSkill() {
    if (!draft.profile) return;
    setProfile(addSkill(draft.profile, newSkill));
    setNewSkill('');
  }

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return {
    draft,
    loadError,
    saveResult,
    uploadResult,
    setProfile,
    uploadResume,
    save,
    reload,
    newSkill,
    setNewSkill,
    addNewSkill,
  };
}
