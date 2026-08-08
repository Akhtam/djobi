# @djobi/shared

Zod schemas shared between the backend (`apps/backend`) and, eventually, the Chrome extension
(`apps/extension`). These are the single source of truth for the shape of a profile, an extracted
job posting, a tailored resume, and the fields autofill acts on — both packages import the same
types instead of maintaining parallel copies.

## Files

### `src/schemas.ts`

All schemas live here, in the order data flows through the app:

- **`WorkExperienceSchema` / `EducationSchema` / `StorySchema`** — building blocks of a profile.
  `StorySchema` is STAR-format (situation/task/action/result) plus free-text `tags[]`; it exists so
  `answerQuestions` has structured, reusable anecdotes to match against a freeform question instead
  of just the top-level profile fields.
- **`ProfileSchema`** — the whole base profile: contact info, links, `workExperience[]`,
  `education[]`, `skills[]`, `stories[]`. This is what gets stored whole in the `profiles.data`
  jsonb column (see `apps/backend/README.md`) and passed into every LLM call as ground truth —
  the tailoring/answering prompts are explicitly instructed never to invent facts outside it.
- **`JobInfoSchema`** — the structured output of `extractJob`: company, team, role, seniority,
  requirements[], keywords[]. `requirements`/`keywords` exist as separate arrays because they're
  used differently downstream — requirements shape which experience gets emphasized, keywords are
  terms worth echoing verbatim for resume-scanner matching.
- **`TailoredResumeSchema`** — the structured output of `tailorResume`: a job-specific summary,
  skills subset, and reworded/reordered `workExperience[]`. Intentionally a _subset_ of `Profile`
  shape (no `education`, no `links`) — those don't need tailoring per job.
- **`FieldCategorySchema` / `DetectedFieldSchema`** — the vocabulary the (not-yet-built) content
  script uses to classify form fields on an ATS page (first name, email, resume upload, freeform
  `question`, etc.) and report them back to the backend.
- **`QuestionAnswerSchema`** — one drafted answer to one detected `question` field.
  `sourceStoryIds[]` records which `Story.id`s the model drew on, so the review UI can show "this
  answer used your 'billing migration' story" instead of an opaque block of text.
- **`ApplicationStatusSchema`** — `'draft' | 'submitted'`, used on the `applications` table.

Every object schema is exported both as the zod value (`FooSchema`, for runtime validation) and as
a TypeScript type (`type Foo = z.infer<typeof FooSchema>`) — import whichever one you need.

### `src/index.ts`

Barrel file — re-exports everything from `schemas.ts`. Import from `@djobi/shared`, not
`@djobi/shared/src/schemas`.

### `src/schemas.test.ts`

One `describe` block per schema. Each covers: a fully valid object parses, a required field
missing fails, and any schema-specific edge case worth pinning down (nullable fields accepting
`null`, an embedded invalid `Story` failing the parent `Profile`, every `FieldCategory` enum value
being accepted). Run with `pnpm --filter @djobi/shared test`.

### `vitest.config.ts`

Minimal Vitest config (Node environment, no globals — tests import `describe`/`it`/`expect`
explicitly from `vitest`).
