/**
 * `@djobi/shared` — everything the backend, extension and dashboard must agree on.
 *
 * - `schemas.ts` — Profile, Job Info, Tailored Resume, Question Answer and Application shapes.
 * - `detectedField.ts` — a Detected Field and the rules for getting an answer back onto it.
 * - `wire.ts` — per-route request/response schemas.
 * - `labelMatching.ts` — when two labels count as the same.
 * - `keywordCoverage.ts` / `requirementEvidence.ts` — what a resume evidences of a posting.
 * - `requirementImportance.ts` — caps an importance band the posting cannot back.
 * - `bulletProvenance.ts` — which Profile bullet each Tailored Resume bullet likely came from.
 * - `httpUrl.ts` / `jobKey.ts` — posting URL validity and identity.
 * - `screeningAnswers.ts` / `preparedAnswers.ts` — facts a Profile answers without a model.
 * - `duplicateGuard.ts` — the fail-open Duplicate Guard lookup.
 * - `applicationPayload.ts` — building a saved Application's payload.
 *
 * Form-to-Profile normalization lives in `@djobi/profile-editor`: only the two frontends need it.
 */
/**
 * zod re-exported so consumers compose the shared schemas on the same zod version.
 */
export { z } from 'zod';
export type { output as ZodTypeOf, ZodError, ZodType } from 'zod';

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
