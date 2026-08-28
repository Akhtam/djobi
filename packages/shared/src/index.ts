/**
 * `@djobi/shared` — everything the backend and the Chrome extension both have to agree on.
 *
 * - `schemas.ts` — the Profile, Job Info, Tailored Resume, Question Answer and Application shapes.
 * - `detectedField.ts` — a Detected Field and the rules for getting an answer back onto it.
 * - `wire.ts` — operation-specific transport schemas and aliases shared by both sides.
 * - `labelMatching.ts` — when two labels count as the same, under a name per rule.
 * - `keywordCoverage.ts` — what a Tailored Resume evidences of a posting's keywords.
 * - `jobKey.ts` — the URL identity of a job posting, shared by draft scoping and the Duplicate Guard.
 * - `screeningAnswers.ts` / `preparedAnswers.ts` — the facts a Profile answers without a model.
 */
/**
 * The zod type vocabulary, re-exported so a consumer can *hold* a schema without depending on zod
 * itself. `apps/extension` needs this to take a response schema as a parameter (see
 * `lib/callBackend.ts`); giving it a direct zod dependency instead would let the two halves of every
 * shared schema drift onto different zod versions, which is the one thing this package exists to
 * prevent.
 */
export type { TypeOf as ZodTypeOf, ZodError, ZodTypeAny } from 'zod';

export * from './detectedField.js';
export * from './schemas.js';
export * from './wire.js';
export * from './resumeFileName.js';
export * from './labelMatching.js';
export * from './keywordCoverage.js';
export * from './jobKey.js';
export * from './screeningAnswers.js';
export * from './preparedAnswers.js';
