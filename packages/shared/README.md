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
  `apps/backend/README.md`). Each operation receives only the Profile projection it uses; tailoring
  and answering treat those projected facts as ground truth and are instructed not to invent facts.
  `ProfileSchema.parse` fills only fields with explicit `.default(...)` declarations. Use
  `parseProfile` when a partial stored value must be completed against `EMPTY_PROFILE`, rather than
  assuming schema parsing invents defaults for every field.
- **`JobInfoSchema`** — the structured output of `extractJob`: company, team, role, seniority,
  `requirements[]`, `keywords[]`. Those last two are separate arrays because they're used
  differently downstream — requirements shape which experience gets emphasized, keywords are terms
  worth echoing verbatim for resume scanners.
- **`TailoredResumeSchema`** — the output of `tailorResume`: the Profile's complete skills list,
  unchanged and in profile order, plus reworded/reordered `workExperience[]`. Intentionally a
  _subset_ of Profile shape (no `education`, no `links`) — those don't need tailoring per job.
- **`QuestionAnswerSchema`** — one drafted answer to one `question` field. `sourceStoryIds[]`
  records which `Story.id`s the model drew on, so the review UI can say "this used your 'billing
  migration' story" instead of showing an opaque block of text.
- **`ApplicationStageSchema`** — `'applied' | 'phone_screen' | 'onsite' | 'offer' | 'rejected'`: how far
  an Application has got. Listed in pipeline order — which is the order a stage picker offers them
  in, and which `apps/dashboard` reads off `.options` rather than restating.

  There was also an `ApplicationStatusSchema` (`'draft' | 'submitted'`) meant to answer "was this
  actually sent to the employer". It was removed because nothing ever set `submitted`, so it carried
  no information. The removal does not establish that every stored Application was submitted; the
  app has no authoritative submission event.

- **`NoteSchema` / `NoteCategorySchema` / `NewNoteSchema`** — one timestamped entry in an
  Application's notes log, filed as `technical` / `behavioral` / `general`. The log is appended to,
  never overwritten, so interview questions recorded against one application stay usable as
  preparation for the next. `NewNote` is `Note` minus the `id`/`createdAt` the server assigns,
  derived from `NoteSchema` rather than hand-written so the two can't drift.
- **`ApplicationSchema` / `NewApplicationSchema` / `ApplicationSnapshotSchema`** — one persisted
  Application, in three shapes for the three things that touch it:
  - `Application` is the whole record, `stage` and `notes` included, plus four nullable Phase 19
    fields: `rawDescription` (the posting text `extractJob` analyzed), `extractionVersion` (a
    compatibility marker, `.default(EXTRACTION_VERSION)` on `NewApplicationSchema` so every write
    is stamped automatically), `requirementEvidence` and `bulletProvenance` (see those modules
    below).
  - `NewApplication` is it minus `id`/`createdAt` (the server assigns those), with `stage`
    defaulting to `'applied'` and `notes` to `[]` — the extension's Save Step posts neither. It's
    what `POST /applications` validates.
  - `ApplicationSnapshot` is `NewApplication` minus `source`/`stage`/`notes`, and is what `PATCH
/applications/:id` validates. Provenance and interview tracking belong to the persisted record, not
    to the autofill run, so a re-save must never overwrite them — though a re-save _does_ recompute
    and resend `rawDescription`/`requirementEvidence`/`bulletProvenance`, since those describe the
    reviewed snapshot itself.
- **`summary` / `projects[]` / `certifications[]` / `awards[]` on `ProfileSchema`** (Phase 20) — the
  resume content a hand-entered Profile had no home for. `certifications`/`awards` stay two separate
  arrays (a certification has no description, an award has no expiry) even though both editors merge
  them into one UI list. `ExtractedProfileSchema` is the extractable subset of these plus the
  original Profile fields; `ExtractResumeResponseSchema` (`wire.ts`) is its response wrapper for
  `POST /profile/extract-resume`.
- **`SignInRequestSchema`/`SignInResultSchema`, `SignUpRequestSchema`/`SignUpResultSchema`,
  `SignOutResultSchema`** — the auth wire contracts both clients validate against
  (`docs/multi-tenant-auth.md`). `SignUpRequestSchema` pins `minPasswordLength: 8`, matching
  `auth.ts`'s own Better Auth config.

`EMPTY_PROFILE` and `parseProfile` live here too, beside the schema whose defaults they mirror.
`parseProfile` completes a stored Profile against `EMPTY_PROFILE` — including a nested merge of
`links`, which a top-level spread cannot reach — and validates the result, so a profile written
before a field existed reads back whole instead of `undefined` somewhere far away.

Every object schema is exported both as the zod value (`FooSchema`) and as a TypeScript type
(`type Foo = z.infer<typeof FooSchema>`) — import whichever you need.

### `src/detectedField.ts`

**What a Detected Field is, and the rules for getting an answer back onto one.** The schema plus its
rules live together here because the rules used to be prose in six separate files, each re-derived
where it was needed.

- **`FieldCategorySchema`** — what a field _is_ (first name, email, resume upload, freeform
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
- **`DetectedFieldSchema`** — one thing on an application page the candidate fills in. A whole group
  of choices answering one question (a fieldset, a `role="radiogroup"`, radios sharing a `name`) is
  **one** Detected Field with the choices as its `options`, not N fields.
- **`parseDetectedFields`** — applied at the two boundaries that actually skew: `tabStore.read`,
  where `chrome.storage.session` outlives an extension reload and can hold a field written by an
  older build, and the router's `REPORT_JOB_PAGE`, where an orphaned content script keeps reporting
  the shape it knows. Schema defaults mean an older field parses rather than being dropped; a field
  that genuinely no longer fits costs that field, not the form.
- **`optionFor` / `matchAnswerToField`** — recovering the option (and so the element) an answer
  names, under the invariant that **an ambiguous match is no match**.

### `src/wire.ts`

**Operation-specific transport schemas and route aliases, owned in one place** so the extension and
backend derive those contracts from the same artifact instead of restating them. Domain write
shapes such as `NewApplicationSchema` and `ApplicationSnapshotSchema` stay in `schemas.ts`.

This is not cosmetic deduplication. Zod's `.object()` strips unknown keys, so a field the extension
sends and the route's private schema doesn't declare is deleted in transit with no error on either
side — which is exactly what happened to `knownAnswer`, silently dropped before `answerQuestions`
ever saw it, so the prompt paragraph treating a work-authorization answer as binding fact never ran
in production. One schema per body makes that class of drift a compile error.

Also holds `BackendErrorBodySchema`, the deliberately small `{ error }` shape `app.ts` renders and
`callBackend` reads back. Structured-call retry classification stays inside the backend operation
that can act on it rather than crossing the wire to a client with no branch for it.

Application response schemas in this file describe the optimized contracts selected with the
explicit `response=compact` query parameter. Omitting it is intentionally backward-compatible:
job-URL lookups return `Application[]`, and Application writes return the full `Application`.
Compact create/update acknowledgements, duplicate summaries, stage results, and note results avoid
loading or transferring persisted snapshots that current clients do not read.

### `src/labelMatching.ts`

**When two labels count as the same**, with a name per rule and a table saying which to use when. A
choice question travels a loop across both processes — `content/detectFields.ts` scrapes each
choice's label (and `background/apiDetectors.ts` may overlay the ATS API's wording), only the labels
cross to the backend, `llm/answerQuestions.ts` constrains the drafted answer to be one of them
verbatim, and `content/fillForm.ts` matches that answer back to recover the element to click.

The loop only closes if all three agree on the rule. They each used to carry a private
`text.trim().toLowerCase()`; change one and the others silently stop matching, which surfaces as a
choice question that just doesn't get filled. `normalizeLabel`, `labelsMatch`, `matchOptionLabel`,
`containsLabel`, `matchByContainment` and `matchPreparedAnswerToOption` live here so loosening a
rule moves every site at once.

The ambiguity invariant — **more than one candidate means no match** — is implemented once, in
`uniqueMatch`, rather than re-derived at each call site.

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

Mapping a prepared answer onto a form's own wording is `matchPreparedAnswerToOption`, in
`labelMatching.ts` alongside every other label rule. It is deliberately **more forgiving** than the
exact `matchOptionLabel` and deliberately a separate rule from it: a prepared answer was typed by
hand months earlier with no knowledge of how a given form words its choices, so it tries exact, then
a unique word-boundary prefix, then a unique substring. Every fallback insists the match be unique —
two options both containing the stored answer means it doesn't say which is meant, and a coin flip
on a legal declaration is worse than leaving it to be resolved with the fact in hand.

### `src/preparedAnswers.ts`

Splits detected questions into the ones the Profile already answers and the ones the model must
draft. Three outcomes, and the distinction between the last two is the point of the module:

- **Resolved** — the Profile holds the answer and it fits the field as-is. Used verbatim; never
  reaches the model.
- **Known but unmapped** — the Profile holds the answer but the field's options don't clearly name
  it. The fact is certain, only its _wording_ is in question, so the question goes to the model
  carrying `knownAnswer` as ground truth to be mapped rather than decided. Backend reconciliation
  then independently enforces direct matches and high-confidence authorization/sponsorship polarity;
  an unsafe mapping is omitted rather than guessed.
- **Unknown** — drafted as normal.

Lives here because both sides need it: the extension splits before calling the backend, and the
backend both prompts with and validates `knownAnswer`.

### `src/jobKey.ts`

**A URL identity for a job posting, rather than for the ATS screen the candidate happens to be
looking at.** `jobKeyForUrl` strips a trailing `/application` or `/apply` route, drops `utm_*` and
the other tracking parameters, and sorts what's left; `isSameJobUrl` compares two URLs through it.

It lives here because both sides depend on the same key. The extension scopes a Job Description
draft to it, so collecting the posting on an overview route and then navigating to the application
route doesn't erase the draft (Ashby `pushState`s exactly that transition). The backend derives
`applications.job_key` on write and matches the Duplicate Guard on it, so a posting revisited
through an ad link is still recognized — matching the raw URL alone missed that, at a cost of three
LLM calls and a re-application each time.

A key the extension computed one way and the backend another would silently stop matching, which is
the whole reason it isn't two private helpers.

### `src/resumeFileName.ts`

`resumeFileName(fullName)` — the filename the generated Tailored Resume is attached under.

### `src/keywordCoverage.ts` / `src/requirementEvidence.ts`

**Keyword Coverage** and **Requirement-to-Evidence Matching** — two deterministic, no-model-call
checks of what a Tailored Resume actually evidences of a posting, run after tailoring rather than
fed back into it. `keywordCoverage.ts` checks `JobInfo.keywords` whole-word against the resume;
`requirementEvidence.ts` does the same for each stated qualification in `JobInfo.requirements`, with
a richer verdict (evidenced / evidenced-as-bare-skill / dropped-from-this-resume / uncertain / not
evidenced). Both are reports, deliberately never corrections: `reconcileResume` already forces every
tailored skill and bullet through the authoritative Profile, so neither module can add anything to a
resume — only say what's already there. `Application.requirementEvidence` persists the latter's
result as a snapshot at save time.

### `src/bulletProvenance.ts`

Pairs a Tailored Resume's bullets back to the Profile sentence each most likely came from, for the
panel's "Originally: …" line and the persisted `Application.bulletProvenance` audit trail. Necessarily
best-effort: `TailoredResume` carries plain strings on the wire, so a verbatim match (a starred
bullet, or one `bulletTruthfulness.ts` reverted) is exact, and anything else is the closest word
overlap among that role's Profile bullets.

### `src/duplicateGuard.ts`

`DuplicateApplicationSummary`'s shape (in `wire.ts`) plus the flattened summary the Duplicate Guard's
callers actually need — five fields, not a whole `Application`, so a check that deliberately did no
analysis work doesn't carry a tailored resume and every answer along for the ride.

### `src/applicationPayload.ts`

Assembles a saved Application's payload — the fields common to every write path except `source`.
`manualApplicationPayload` (Log tab / dashboard "Log an application") and
`autofillApplicationPayload` (the Application Pipeline's Save Step) replace what used to be built by
hand at three call sites, two of them byte-identical, each independently having to remember that
`requirementEvidence`/`bulletProvenance` are computed against the _stored_ resume, not the whole
Profile.

### `src/failureMessage.ts`

`failureMessage(value)` — turns an unknown rejection value into a stable diagnostic string. Small and
shared because "what do we log/show when a promise rejects with something that isn't an `Error`" was
answered slightly differently at each call site before this.

### `src/index.ts`

Barrel — re-exports all of the above. Import from `@djobi/shared`, not `@djobi/shared/src/schemas`.

## Tests

One `describe` per schema in `schemas.test.ts`; each covers a valid parse, a missing required field,
and any schema-specific edge case worth pinning (nullable fields accepting `null`, an embedded
invalid `Story` failing the parent `Profile`, every `FieldCategory` value being accepted).
`applicationPayload`, `bulletProvenance`, `detectedField`, `duplicateGuard`, `failureMessage`,
`jobKey`, `keywordCoverage`, `labelMatching`, `preparedAnswers`, `requirementEvidence`,
`resumeFileName` and `wire` have their own test files.

**`screeningAnswers.ts` is the only module here with no test file** — so `matchScreeningTopic`'s
order-dependent matching, where "authorized to work without sponsorship?" has to resolve to work
authorization rather than sponsorship, is covered only indirectly through `preparedAnswers`.

Run with `pnpm --filter @djobi/shared test`.

### `vitest.config.ts`

Minimal Vitest config (Node environment, no globals — tests import `describe`/`it`/`expect`
explicitly from `vitest`).
