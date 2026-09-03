/**
 * `@djobi/profile-editor` — the behavior behind editing a Profile as a form: the draft itself, the
 * per-section list operations, and the work-experience bullet rules. Both `apps/extension/src/
 * options/App.tsx` and `apps/dashboard/src/views/Profile.tsx` edit the same Profile and used to
 * hand-roll all of this identically; only the chrome around it — the panel/card shell, the save
 * affordance, how a 401 is reported — is genuinely different between the two, and stays in each app.
 *
 * - `useProfileDraft.ts` — the draft itself: what's being edited, whether it's dirty, and the
 *   revision guard that keeps a save's response from clobbering an edit made after it started.
 * - `listEditing.ts` — `listEditor`/`ListEditor<T>` (add/update/remove for one Profile list key)
 *   and `credentialItems` (the combined Certifications & Awards view).
 * - `bulletEditing.ts` — starring a work-experience bullet, and parsing its per-role bullet cap.
 * - `profileDraft.ts` — normalizing a Profile draft into the shape persisted by the backend,
 *   applying a resume extraction onto one, and the screening-answer/credential-kind edits.
 */
export * from './useProfileDraft.js';
export * from './listEditing.js';
export * from './bulletEditing.js';
export * from './profileDraft.js';
