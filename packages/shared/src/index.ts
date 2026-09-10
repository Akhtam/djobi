/**
 * `@djobi/shared` — everything the backend and the Chrome extension both have to agree on.
 *
 * - `schemas.ts` — the Profile, Job Info, Tailored Resume, Question Answer and Application shapes.
 * - `detectedField.ts` — a Detected Field and the rules for getting an answer back onto it.
 * - `wire.ts` — operation-specific transport schemas and aliases shared by both sides.
 * - `labelMatching.ts` — when two labels count as the same, under a name per rule.
 * - `keywordCoverage.ts` — what a Tailored Resume evidences of a posting's keywords.
 * - `requirementEvidence.ts` — what a Tailored Resume/Profile evidences of a posting's requirements.
 * - `requirementImportance.ts` — the gate capping an importance band the posting cannot back.
 * - `bulletProvenance.ts` — which Profile sentence each Tailored Resume bullet most likely came from.
 * - `httpUrl.ts` — the schemes a posting URL may be stored and rendered under.
 * - `jobKey.ts` — the URL identity of a job posting, shared by draft scoping and the Duplicate Guard.
 * - `screeningAnswers.ts` / `preparedAnswers.ts` — the facts a Profile answers without a model.
 * - `duplicateGuard.ts` — what the candidate already has on file for a posting, failing open.
 * - `applicationPayload.ts` — assembling a saved Application's payload, manual and autofill alike.
 *
 * Normalizing a Profile edited as a form (dashboard and extension both edit one) into the shape
 * persisted by the backend lives in `@djobi/profile-editor` instead — Profile-editing logic used by
 * nothing but the two frontends that edit one, not a wire contract the backend needs to agree on.
 */
/**
 * The zod builder and type vocabulary, re-exported so consumers compose the shared schemas without
 * taking a second zod dependency. `apps/extension` uses both: response schema parameters in
 * `lib/callBackend.ts`, and its internal message boundary in `lib/messages.ts`. Resolving both
 * through this package keeps the two halves of every composed schema on one zod version.
 */
export { z } from 'zod';
export type { TypeOf as ZodTypeOf, ZodError, ZodTypeAny } from 'zod';

export * from './detectedField.js';
export * from './schemas.js';
export * from './wire.js';
export * from './resumeFileName.js';
export * from './labelMatching.js';
export * from './keywordCoverage.js';
export * from './requirementEvidence.js';
export * from './requirementImportance.js';
export * from './bulletProvenance.js';
export * from './httpUrl.js';
export * from './jobKey.js';
export * from './screeningAnswers.js';
export * from './preparedAnswers.js';
export * from './failureMessage.js';
export * from './duplicateGuard.js';
export * from './applicationPayload.js';
