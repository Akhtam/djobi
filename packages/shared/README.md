# @djobi/shared

Zod schemas, types and the rules the backend, extension, dashboard and other workspace packages must
agree on. Anything here would otherwise be copied privately and drift. Domain terms (**Profile**,
**Job Info**, **Tailored Resume**, **Question Answer**, **Detected Field**, **Application**) are
defined in the root `CONTEXT.md`. Import from `@djobi/shared` (the `src/index.ts` barrel).

Every object schema is exported as both the zod value (`FooSchema`) and its inferred type (`Foo`).

## Modules

### `schemas.ts` — domain shapes

- **Profile**: `ProfileSchema` built from `WorkExperienceSchema`, `EducationSchema`, `StorySchema`
  (STAR anecdotes with `tags[]` that `answerQuestions` matches against), plus `summary`,
  `projects[]`, `certifications[]`, `awards[]` and prepared answers. Stored whole in the
  `profiles.data` jsonb column. `ProfileSchema.parse` only fills explicit `.default(...)` fields; use
  `parseProfile` to complete a stored partial Profile against `EMPTY_PROFILE` (including a nested
  merge of `links`).
- **`ExtractedProfileSchema`** — the subset a resume PDF can honestly supply; everything nullable,
  so a partial extraction leaves blanks rather than invented values.
- **`JobInfoSchema`** — `extractJob`'s output: company, team, role, seniority, `requirements[]` (with
  `kind`, Importance Band/Tier and Posting Signal) and `keywords[]` (with category and
  `postingSpelling`). Legacy bare-string rows lift to the object shape on read.
- **`TailoredResumeSchema`** — `tailorResume`'s output: the Profile's full skills list plus tailored
  `workExperience[]`. `baseResumeOf` projects a Profile into it untailored (the Base Resume).
- **`QuestionAnswerSchema`** — one drafted answer; `sourceStoryIds[]` names the stories used.
- **`ApplicationStageSchema`** — `applied → rejected_ats → phone_screen → onsite → offer → rejected`,
  in picker order. There is no draft/submitted status: nothing in the flow can observe a real
  submission.
- **`NoteSchema` / `NewNoteSchema`** — append-only notes log entries; `id`/`createdAt` are
  server-assigned.
- **`ApplicationSchema` / `NewApplicationSchema` / `ApplicationSnapshotSchema`** — the persisted row;
  the `POST /applications` body (`stage`/`notes` defaulted, `extractionVersion` stamped); and the
  `PATCH /applications/:id` body, which omits `source`/`stage`/`notes` so a re-save never overwrites
  provenance or tracking.

### `wire.ts` — route contracts

One schema per route body/response, shared so a field can't be silently stripped by a route's
private copy. Includes Better Auth's sign-in/up/out shapes, `/analyze`, `/answer-chat`, profile and
application routes, and `BackendErrorBodySchema` (`{ error, code? }`, where `code` is currently only
`'invalid-model-output'`). Application routes accept `response=compact` for small acknowledgements;
without it they return full rows.

### `detectedField.ts`

A Detected Field and the rules for getting an answer back onto it: `FieldCategorySchema`,
`ElementRoleSchema` (how `fillForm.ts` interacts), `FieldOptionSchema` (label plus nullable
selector), `parseDetectedFields` (drops entries from an older extension build rather than failing
the batch), and `optionFor`/`matchAnswerToField` — where **an ambiguous match is no match**.

### `labelMatching.ts`

Every "are these two labels the same?" rule, named, with a table of which to use when. Ambiguity
always resolves through `uniqueMatch`: more than one candidate means no match.

### `screeningAnswers.ts` / `preparedAnswers.ts`

Prepared answers — work authorization, sponsorship and similar facts — stored once and filled
verbatim, never drafted by a model. `SCREENING_TOPICS` is the single source for the topic enum,
matcher order (order matters where topics overlap) and editor rows. `splitPreparedQuestions` sorts
questions into resolved, known-but-unmapped (sent to the model with `knownAnswer` to map, not
decide) and unknown.

### `jobKey.ts` / `httpUrl.ts`

`jobKeyForUrl` gives a posting a URL identity that survives `/application`/`/apply` routes and
tracking params; the extension scopes Job Context by it and the backend matches the Duplicate Guard
on it. `isHttpUrl`/`HttpUrlSchema` accept only `http(s):`, so a stored `jobUrl` can't be a
`javascript:` link.

### `keywordCoverage.ts` / `requirementEvidence.ts` / `requirementImportance.ts`

Deterministic, no-model checks. Keyword Coverage and Requirement-to-Evidence Matching report what a
Tailored Resume evidences of a posting — reports, never fed back into tailoring. The Importance Gate
caps any `critical`/`high` band that isn't backed by a verbatim quote from the posting.

### `bulletProvenance.ts`

Pairs each Tailored Resume bullet with its likely Profile source bullet, for the review panel and
the persisted `Application.bulletProvenance`.

### `duplicateGuard.ts` / `applicationPayload.ts` / `failureMessage.ts` / `resumeFileName.ts`

`findDuplicate` is the fail-open Duplicate Guard lookup every caller shares.
`manualApplicationPayload` / `autofillApplicationPayload` build save payloads. `failureMessage`
turns any rejection value into a stable string. `resumeFileName` names the generated PDF.

## Tests

Each module has its own test file except `screeningAnswers.ts`, whose matching is covered in
`preparedAnswers.test.ts`. Run with `pnpm --filter @djobi/shared test`.
