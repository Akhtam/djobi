# @djobi/shared

Zod schemas, types, and the handful of rules that **both** the backend (`apps/backend`) and the
Chrome extension (`apps/extension`) have to agree on. Anything in here is here because two processes
would otherwise keep private copies of it and drift apart.

Domain terms below (**Profile**, **Job Info**, **Tailored Resume**, **Question Answer**,
**Detected Field**, **Application**) are defined in the repo-root `CONTEXT.md`.

## Files

### `src/schemas.ts`

All schemas, in the order data flows through the app:

- **`WorkExperienceSchema` / `EducationSchema` / `StorySchema`** — building blocks of a Profile.
  `StorySchema` is STAR-format (situation/task/action/result) plus free-text `tags[]`; it exists so
  `answerQuestions` has structured, reusable anecdotes to match a freeform question against instead
  of just the top-level profile fields.
- **`ProfileSchema`** — the whole base Profile: contact info, links, `workExperience[]`,
  `education[]`, `skills[]`, `stories[]`, plus the prepared answers described under
  `screeningAnswers.ts` below. Stored whole in the `profiles.data` jsonb column (see
  `apps/backend/README.md`) and passed into every LLM call as ground truth — the tailoring and
  answering prompts are explicitly instructed never to invent facts outside it.
  **Its defaults are the authority on Profile shape**: parse an incomplete stored profile through
  this schema rather than spreading it over a hand-written empty object.
- **`JobInfoSchema`** — the structured output of `extractJob`: company, team, role, seniority,
  `requirements[]`, `keywords[]`. Those last two are separate arrays because they're used
  differently downstream — requirements shape which experience gets emphasized, keywords are terms
  worth echoing verbatim for resume scanners.
- **`TailoredResumeSchema`** — the structured output of `tailorResume`: a job-specific summary,
  skills subset, and reworded/reordered `workExperience[]`. Intentionally a _subset_ of Profile
  shape (no `education`, no `links`) — those don't need tailoring per job.
- **`FieldCategorySchema`** — what a Detected Field _is_ (first name, email, resume upload, freeform
  `question`, …).
- **`ElementRoleSchema`** — `'native' | 'combobox' | 'radiogroup' | 'checkboxgroup'`: how
  `fillForm.ts` must _interact_ with a field, kept separate from its semantic category because the
  two vary independently. A work-authorization question is the same `question` category whether the
  ATS renders it as a `<select>` or a react-select combobox, but filling it differs completely.
- **`FieldOptionSchema`** — one choice on a choice-shaped field: the `label` a candidate reads, and
  a nullable `selector` for the element. The two are kept apart deliberately — re-deriving a
  choice's label from the DOM at fill time is fragile, since every ATS associates option labels
  differently. `selector` is null for choices known only from an ATS API schema or from a listbox
  that mounts on open; those fall back to label matching.
- **`DetectedFieldSchema`** — one thing on an application page the candidate fills in. Note a whole
  group of choices answering one question (a fieldset, a `role="radiogroup"`, radios sharing a
  `name`) is **one** Detected Field with the choices as its `options`, not N fields.
- **`QuestionAnswerSchema`** — one drafted answer to one `question` field. `sourceStoryIds[]`
  records which `Story.id`s the model drew on, so the review UI can say "this used your 'billing
  migration' story" instead of showing an opaque block of text.
- **`ApplicationStatusSchema`** — `'draft' | 'submitted'`.
- **`ApplicationSchema` / `NewApplicationSchema`** — one persisted Application. `NewApplication` is
  `Application` minus `id`/`createdAt` (the server assigns those), with `status` defaulting to
  `'draft'`; it's what `POST /applications` validates.

Every object schema is exported both as the zod value (`FooSchema`) and as a TypeScript type
(`type Foo = z.infer<typeof FooSchema>`) — import whichever you need.

### `src/optionLabel.ts`

**The option-label protocol**: when are two choice labels "the same"? A choice question travels a
loop across both processes — `content/detectFields.ts` scrapes each choice's label (and
`background/apiDetectors.ts` may overlay the ATS API's wording), only the labels cross to the
backend, `llm/answerQuestions.ts` constrains the drafted answer to be one of them verbatim, and
`content/fillForm.ts` matches that answer back to recover the element to click.

The loop only closes if all three agree on the rule. They each used to carry a private
`text.trim().toLowerCase()`; change one and the others silently stop matching, which surfaces as a
choice question that just doesn't get filled. `normalizeLabel`, `labelsMatch` and `matchOptionLabel`
live here so loosening the rule moves all three at once.

### `src/screeningAnswers.ts`

**Prepared answers** — the facts an application asks for over and over (work authorization,
sponsorship, veteran status), stored once on the Profile so nothing has to infer them per
application. These are matters of fact with one correct answer that's the same on every form;
drafting them from a model is wasted work and the one place a wrong answer really costs something,
since a guessed "yes" to a sponsorship question is a misrepresentation on a legal document.

`SCREENING_TOPICS` is the single source of truth — the topic enum, the matcher order, and the
options editor's rows are all derived from it, so a new topic is added here and nowhere else.
Matcher **order is load-bearing** where topics overlap: "authorized to work without sponsorship?"
mentions both and reads as work authorization, so that topic is tried first.

Also holds `resolveAnswerOption`, deliberately **more forgiving** than `optionLabel.ts`'s exact
match and deliberately separate from it: a prepared answer was typed by hand months earlier with no
knowledge of how a given form words its choices, so it tries exact, then a unique word-boundary
prefix, then a unique substring. Every fallback insists the match be unique — two options both
containing the stored answer means it doesn't say which is meant, and a coin flip on a legal
declaration is worse than leaving it to be resolved with the fact in hand.

### `src/preparedAnswers.ts`

Splits detected questions into the ones the Profile already answers and the ones the model must
draft. Three outcomes, and the distinction between the last two is the point of the module:

- **Resolved** — the Profile holds the answer and it fits the field as-is. Used verbatim; never
  reaches the model.
- **Known but unmapped** — the Profile holds the answer but the field's options don't clearly name
  it. The fact is certain, only its _wording_ is in question, so the question goes to the model
  carrying `knownAnswer` as ground truth to be mapped rather than decided.
- **Unknown** — drafted as normal.

Lives here because both sides need it: the extension splits before calling the backend, and the
backend puts `knownAnswer` into the prompt.

### `src/resumeFileName.ts`

`resumeFileName(fullName)` — the filename the generated Tailored Resume is attached under.

### `src/index.ts`

Barrel — re-exports all of the above. Import from `@djobi/shared`, not `@djobi/shared/src/schemas`.

## Tests

One `describe` per schema in `schemas.test.ts`; each covers a valid parse, a missing required field,
and any schema-specific edge case worth pinning (nullable fields accepting `null`, an embedded
invalid `Story` failing the parent `Profile`, every `FieldCategory` value being accepted).
`optionLabel`, `preparedAnswers` and `resumeFileName` have their own test files.

**`screeningAnswers.ts` is the only module here with no test file** — including
`resolveAnswerOption`, whose uniqueness rule is the thing standing between a stored answer and the
wrong box on a legal declaration.

Run with `pnpm --filter @djobi/shared test`.

### `vitest.config.ts`

Minimal Vitest config (Node environment, no globals — tests import `describe`/`it`/`expect`
explicitly from `vitest`).
