/**
 * `@djobi/shared` — everything the backend and the Chrome extension both have to agree on.
 *
 * - `schemas.ts` — the Profile, Job Info, Tailored Resume, Question Answer and Application shapes.
 * - `detectedField.ts` — a Detected Field and the rules for getting an answer back onto it.
 * - `wire.ts` — the request body of every backend route, so both sides derive from one artifact.
 * - `labelMatching.ts` — when two labels count as the same, under a name per rule.
 * - `screeningAnswers.ts` / `preparedAnswers.ts` — the facts a Profile answers without a model.
 */
export * from './detectedField.js';
export * from './schemas.js';
export * from './wire.js';
export * from './resumeFileName.js';
export * from './labelMatching.js';
export * from './screeningAnswers.js';
export * from './preparedAnswers.js';
