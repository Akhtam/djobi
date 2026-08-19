# djobi — Progress

**What this is:** a Chrome extension that autofills job applications on ATS sites (Greenhouse,
Ashby, Lever, Workday, ...) with an AI-tailored resume and drafted answers to freeform questions,
backed by a local server and a persisted history of past applications.

Domain vocabulary is in `CONTEXT.md`; per-package detail is in `README.md`, `apps/backend/README.md`
and `packages/shared/README.md`.

**Read this file at the start of a new session** to pick up where the last one left off. It records
what the project _is_ now and what's planned next — not how it got here. Update it as work happens;
history belongs in git, not in this file.

## Current state

Everything below is built, tested and works end to end. Suite green at **620 tests** (116 shared /
85 backend / 356 extension / 63 dashboard), `pnpm test` from the repo root.

- **`packages/shared`** — the zod schemas and the rules both processes must agree on: `schemas.ts`
  (Profile, Job Info, Tailored Resume, Question Answer, Application), `detectedField.ts` (what a
  Detected Field is and how an answer gets back onto one), `wire.ts` (every route body, so drift
  between the two ends is a compile error), `labelMatching.ts` (when two labels are the same),
  `screeningAnswers.ts` / `preparedAnswers.ts` (the facts a Profile answers without a model).
- **`apps/backend`** — Hono on `127.0.0.1:5391`. Three LLM calls (`extractJob`, `tailorResume`,
  `answerQuestions`) through `structuredCall.ts`, a one-page-fitting resume PDF renderer, and
  Postgres persistence (Neon + Drizzle) for profiles and applications. `pnpm --filter backend
build` compiles the shared package and emits a plain-Node production server to `dist/`.
- **`apps/dashboard`** — Vite + React on `localhost:5174`, browsing past Applications and tracking
  their Stage and Notes against the live backend. Two views behind a hand-rolled hash router; one
  `DashboardClient` seam (`lib/dashboardClient.ts`) whose fixture implementation is test-only, so
  every view is exercised without a network while the running app always talks to Postgres.
- **`apps/extension`** — MV3, Vite + `@crxjs/vite-plugin` + React. Content scripts detect the form
  (`detect.ts`) and classify its fields (`detectFields.ts`) and fill them (`fillForm.ts`); the
  service worker runs the pipeline (`applicationPipeline.ts`); the options page edits the Profile;
  the side panel is the review surface. Light/dark theme shared by both pages (`lib/theme.tsx`),
  persisted in `chrome.storage.local`.

The Application Pipeline as it runs today: **paste a job description → duplicate guard → Analysis
Step → review and edit → Fill Step → explicit Save Step.** The panel is hydrated from and
checkpointed to `lib/tabStore.ts` at every stage, so closing it mid-run loses nothing.

The panel has two tabs. **Autofill** is that pipeline. **Log** records a job the candidate applied
to themselves — their own resume, or LinkedIn Easy Apply — so it still lands in the same history:
paste the posting and its URL, `POST /extract-job` for the details, then `POST /applications` with
`source: 'manual'` and the base profile in place of a tailored resume. No pipeline, no tab-scoped
state, no page access.

## Key decisions

- **Models:** `claude-haiku-4-5` for job-info extraction, `claude-sonnet-5` for resume tailoring
  and question answering.
- **DB:** Postgres on Neon (cloud), accessed via Drizzle ORM. The backend itself runs locally.
- **Structured output workaround:** the installed `@anthropic-ai/sdk` (0.68.0) has no
  `.messages.parse()` / `zodOutputFormat`. Every LLM call forces a tool call instead and validates
  the result with zod — see `apps/backend/src/llm/structuredCall.ts`. Each tool's `input_schema` is
  derived from its zod schema via `zod-to-json-schema` (pinned exact at 3.24.6, `$refStrategy:
'none'` since Anthropic's `input_schema` doesn't dereference `$ref`). No hand-maintained JSON
  Schema mirrors exist; if one appears, it's a regression.
- **Form filling:** one generic heuristic field-classifier, not per-ATS selectors. ATS platform
  APIs are used as an _oracle_ (classification, required, options) where one exists; the DOM stays
  the targeting mechanism. See `background/apiDetectors.ts`.
- **The Job Description is pasted, never scraped.** The application form is a different page from
  the job ad, so a scrape captured form labels and nav bars instead of the posting. The page is read
  for its _form_ only.
- **Review surface is a side panel, not a popup.** A popup is destroyed on any outside click; the
  panel survives tab switches, and the pipeline runs in the service worker so closing the panel
  mid-run doesn't drop the result.
- **Saving is explicit and separate from filling.** The Fill Step writes the page; the Save Step
  records the Application. The first save creates the record and every later one updates it via
  `PATCH /applications/:id`, so re-filling or re-editing a run can't leave two rows behind.
- **The duplicate guard fails open.** A job URL already saved stops a run at `duplicate` before any
  LLM call, and the candidate can override with "Analyze and apply anyway". A lookup that _errors_
  counts as no duplicates — the guard exists to save the candidate from re-applying, not to make a
  stopped backend the reason Analyze doesn't work.
- **Application tracking is `stage` alone** (applied → phone_screen → interviewing → rejected).
  There was also a `status` field (draft/submitted) for "did this actually go out"; it was dropped
  in migration `0002` because nothing ever set `submitted` — saving is a manual step the candidate
  takes _after_ submitting, so a stored Application is a submitted one and the field was `draft` on
  all 28 rows. Notes are a timestamped, categorized log (`technical` / `behavioral` / `general`)
  you append to, not a single overwritable text field — so old interview-question notes stay around
  as reference for future applications.
- **Process:** this project is built test-first (red → green, one vertical slice at a time) — see
  the `mattpocock-skills:tdd` skill. Continue that pattern for new routes/modules.
- **Repo:** pnpm workspace — `packages/shared` + `apps/backend` + `apps/extension` +
  `apps/dashboard`. GitHub remote: `Akhtam/djobi`.
- **The dashboard is a separate app, not an extension page.** It needs no `chrome.*` API, and
  keeping it out of the MV3 bundle means it can be developed with plain Vite HMR and, later,
  deployed somewhere the extension can't go.

## Constraints that look like mistakes

Load-bearing, recorded nowhere else, and easy to "clean up" into a regression.

- `attachResumeFile` keeps a non-`DataTransfer` fallback branch (shadowing `.files` via
  `Object.defineProperty`) purely because **jsdom has no `DataTransfer` constructor** and no public
  `FileList` constructor either. Production takes the real `DataTransfer` path. This is a test
  environment constraint living in product code — don't simplify it away.
- **Both stage controls are one native `<select>` (`StageSelect`), never a custom widget.** The
  detail page briefly used a hand-built ARIA radiogroup, whose roving tabindex put only the
  selected option in the tab order — with no arrow-key handler that left the control focusable and
  impossible to operate by keyboard. A `<select>` cannot get that wrong. It is also a **fixed
  width**: stage names differ in length, so an intrinsically-sized control reflows the card under
  the pointer at the moment of the click.
- **`addApplicationNote` appends in SQL (`notes || …::jsonb`), not read-modify-write.** Two notes
  added close together — the dashboard open in two tabs, a double-submitted form — both read the
  same array under read-modify-write and the second write silently discards the first. Losing an
  entry is precisely what an append-only log exists to prevent, so the concatenation happens in
  Postgres where it is atomic. `id` and `createdAt` are generated in that function, never accepted
  from the request body.
- **The dashboard's optimistic writes revert one record, and report whether they landed.**
  `useApplicationStore.mutate` restores only the record that failed — snapshotting the whole array
  also undoes any _other_ write that succeeded while this one was in flight. It also resolves
  `true`/`false` rather than just `void`, because it swallows the rejection: a form that clears
  itself on an `await` returning would throw the user's typing away on every failure, and a
  stopped backend is the everyday case. Both are covered in `App.test.tsx`.
- **`apps/dashboard`'s theme reads `localStorage` and `matchMedia` through guards.** Neither exists
  in the jsdom environment its component tests run in, and a browser with site data blocked
  _throws_ on `localStorage` property access rather than returning null. The theme is read before
  anything else is drawn, so an unguarded read takes down the whole app at first render rather than
  degrading. Same shape as the extension's `localThemeStorage()` guard, different missing API.
- **The dashboard's list card is a `<li>` with a stretched link, not an `<a>`.** The stage
  `<select>` on the card is interactive and cannot legally nest inside a link — its clicks navigate
  instead of opening the dropdown. `.card__link::after` covers the card and the badge is layered
  above it, which keeps exactly one real link per row for keyboard and screen-reader users. Turning
  the card back into an anchor silently breaks the stage control.
- **Cover-letter fields (`cover_letter_text` / `cover_letter_upload`) are detected but deliberately
  not filled.** `answerQuestions` is wired only to `question`-category fields. A scope decision,
  not an oversight.
- **The `??` vs `||` trap on the job-description box.** The textarea's display value, the
  Analyze-button disabled check, and the analyze payload must all read the _same_ expression. Use
  different operators in different places and the box either silently reverts the user's typing or
  lets a blank submission through.
- **A fill is only reported as landed if the page kept it.** `fillForm` re-reads each field after a
  300ms settle, because a controlled field whose `onChange` never fired reverts on the _next_
  render — an immediate re-read calls every failed fill a success. A fill also drives the full
  keystroke event sequence (`focus` → `InputEvent('input')` → `change` → `blur`/`focusout`), since
  form libraries commonly commit to the form model on blur; a value write plus `input` leaves the
  DOM looking right and the model empty, which an ATS reports on submit as a missing required field.
- **`runFill`'s `FILLABLE_FROM` list is the panel's own rule, restated where it is enforceable.**
  It is `reviewOf`'s `canReview` set minus the two statuses the Fill button is disabled for, so
  `review`/`fill-error`/`filled`/`save-error`/`saved` are in and `filling`/`saving` are out.
  `filled` and `saved` are in on purpose — re-filling after an edit is supported, and the Save Step
  updates the same record rather than creating a second. Narrowing the list to "only `review`"
  looks tidier and breaks both the retry buttons and every re-fill.
- **A rejected request body is a 400 and is deliberately _not_ logged.** `parseBody`
  (`src/requestBody.ts`) throws `RequestValidationError`, which `app.onError` answers with a 400 and
  no `console.error`. Both halves are load-bearing. Before it, a body that wasn't JSON threw out of
  `c.req.json()`, fell through to `onError`, and became a **500** with a stack trace — so a truncated
  request and an unreachable Postgres printed the same line, and the one signal that means "go look
  at the backend" fired for a fault that was never in the backend. It is app-owned rather than Hono's
  `HTTPException` because that class's `getResponse()` returns a plain-text body, which would put a
  second error shape on a wire the extension parses as `{ error }`.
- **`renderResume.tsx` compiles under `apps/backend/tsconfig.json`'s `"jsx": "react-jsx"`.** That
  tsconfig is what replaced its explicit `import React`; delete or retarget the file and the backend
  build stops compiling JSX, with the error pointing at the component rather than at the config.
- **`packages/shared`'s `exports` now resolves to `dist/`, so shared source edits need a build.**
  `pnpm dev:backend` and `pnpm build:extension` run `pnpm --filter @djobi/shared build` first via
  `pre*` hooks, but `tsx watch` does **not** re-run them — edit a schema in `packages/shared/src`
  mid-session and the backend keeps serving the previously built copy until the filter is run again.
  The `development` condition in that `exports` block is what keeps the extension's vite build and
  vitest reading source directly.
- **The resume PDF fits itself to one page** by re-rendering down a four-step density ladder, never
  touching `fontSize` — leading and whitespace are spendable, legibility is not. Past ~5 roles × 6
  bullets it returns two pages with all content rather than truncating. Every step sits inside a
  range sourced in `docs/resume-design-conventions.md`; the "fill 85–90% of the page" heuristic is
  **folklore** and is not one of them. A resume that comes out thin is a `tailorResume.ts` problem,
  not a stylesheet one.

- **`chrome.tabs.sendMessage` is always given a `frameId` when one is known** (`lib/pageClient.ts`,
  fed by `getDetectedFrame` in `lib/tabStore.ts`). Without it the runtime delivers to _every_ frame
  and resolves with whichever answers first, dropping the rest — and the content script is injected
  into all frames, third-party ones included. A page carrying an invisible hCaptcha or a
  tag-manager pixel therefore had those frames answering `FILL_FORM` with an empty result before
  the frame owning the form finished verifying its writes, so the Fill Step reported "nothing
  filled" regardless of what happened. `content/index.ts` staying silent on `FILL_FORM` in frames
  holding none of the fields is the backstop, and mirrors the same rule `SCAN_PAGE` already
  followed. Collapsing either back to a broadcast reintroduces the bug silently.

## Planned

### Phase 7 — Application tracking data model (done)

Stage/Note schemas, migration `0001_living_captain_stacy.sql`, `updateApplicationStage`,
`addApplicationNote`, `PATCH /applications/:id/stage` and `POST /applications/:id/notes`.

Tracking writes have their own routes rather than riding on `PATCH /applications/:id`, whose body is
an `ApplicationSnapshot` that deliberately excludes stage and notes — folding them in would let a
re-saved autofill stomp interview history.

### Phase 8 — Frontend dashboard (done)

`apps/dashboard` on `localhost:5174`, wired to the backend: applications list with client-side
stage/search filtering and per-card stage editing, and a detail view with a stage picker, the notes
log and composer, and collapsed job info / tailored resume / drafted answers. `hono/cors` added to
`apps/backend/src/app.ts`, registered before the routes with the origin restricted to the
dashboard's dev URLs.

### Phase 9a — Log tab: record an application made by hand (done)

A second tab in the side panel for jobs the candidate applied to without djobi. Migration
`0003_abandoned_sir_ram.sql` adds `applications.source` (`'autofill' | 'manual'`, defaulting to
`'autofill'` so every existing row and the extension's unchanged save path stay valid);
`baseResumeOf` in `packages/shared` projects a Profile into the `TailoredResume` shape, which is
possible because the latter is defined as a subset of the former. The dashboard badges manual rows
and relabels the resume section, since "Tailored resume" would be a false claim on them.

Decisions:

- **A tab, not a mode toggle on the existing flow.** The Log flow shares no state with the pipeline —
  no tracked tab, no detected form, no `PipelineStatus` — so folding it in would mean threading a
  second meaning through every branch of `reviewOf`. It is a form and two backend calls, and its
  state is local to the component for that reason.
- **No new endpoints and no new LLM call.** `POST /extract-job` and `POST /applications` already do
  the work; only the `source` column is new.
- **`source` is omitted from `ApplicationSnapshotSchema`**, alongside `stage` and `notes`: a re-save
  must not be able to relabel how a record was created.
- **`jobUrl` stays required and `.url()`-validated.** It is the duplicate guard's key, so the Log tab
  makes it a required field rather than inventing a placeholder — and it runs the same
  already-applied check before writing, warning without blocking.

Carried in the same change, though not part of Phase 9a: `listApplicationsByCompany` became
`listPriorApplicationsByCompany`, returning a two-column projection instead of whole rows on the
Analyze path; the dashboard's job-URL rendering moved into a shared `PostingLink`; and
`saveProfile`'s upsert was rewritten (see the checklist below).

Not done: the URL is typed or prefilled from the active tab, never fetched. Reading a posting from a
link, or off an open LinkedIn Easy Apply modal, is the larger feature sketched in
`docs/application-info-extraction-mode.md`.

### Phase 9 — Ask tab: answer a pasted question from the Profile (not started)

A second tab in the side panel where the candidate pastes **any** question from an application
they're filling in and gets an answer drafted from their Profile. Answer drafting only ever fires
for `question`-category fields the detector found on the page, so a question the detector missed,
one on a page the extension can't see, or one from a form the candidate is filling elsewhere has no
path to an answer today. This is that path: paste, get a draft, copy it out.

Decisions:

- **Grounded in the Profile, and nothing else is required.** `jobInfo` is optional here — the whole
  point is that this works without a detected job page. When the panel does have a run with
  `jobInfo`, pass it so the answer is tailored; when it doesn't, the Profile alone is the input.
- **Same non-fabrication rule as everywhere else.** The answer may only use what the Profile
  supports — this surface must not become the one place the model is allowed to invent experience.
- **Copy-out, not auto-fill.** The answer lands in a copyable box. This phase adds no new path from
  a drafted answer into a form field; filling stays the Fill Step's job, from detected fields.
- **The panel becomes tabbed.** Today `panel/App.tsx` renders one flow keyed off `status`. This
  needs a tab switcher above it, with the existing pipeline UI as the first tab, so the Ask tab is
  reachable at any point in a run — including `ready`, when there's no run at all.

**Overlaps with Phase 10** (live chat to refine a drafted answer), which is also a chat surface
grounded in `profile`/`jobInfo`. Decide before building: either this phase's route is a single-turn
special case of Phase 10's `/chat-answer` and they share one backend module, or Phase 10 is folded
into this tab and the review UI links into it. Building both independently would put two chat
implementations in one panel.

- [ ] `packages/shared/src/wire.ts`: request/response shape for one ask — a body of `profile`,
      `question` and an optional `jobInfo`, answered with `{ answer }`. A wire schema, so
      `lib/backendClient.ts` can build the body against it via `satisfies` like every other route
- [ ] `apps/backend/src/llm/answerFreeQuestion.ts` — one drafted answer from Profile (+ optional
      `jobInfo`), through `structuredCall.ts`; `MODELS.writing` (Sonnet), same tier and same
      grounding rules as `answerQuestions`. Reuse its `<base_profile>`/`<job_info>` prompt scaffold
      rather than hand-building a third copy (see the open "speculative" item on that duplication)
- [ ] `POST /ask` route — zod-validated against the wire schema, returns the drafted answer
- [ ] `lib/backendClient.ts`: add the method to `BackendClient` and `httpBackendClient`
- [ ] `panel/App.tsx`: a tab switcher — "Application" (everything that renders today) and "Ask"
- [ ] `panel/AskTab.tsx` — question textarea, submit, answer box with a copy button, in-flight and
      error states. Calls the backend directly via `callBackend`, as the panel already does for
      `/profile` and `/render-resume-pdf`; this needs no service-worker involvement since there is
      no run to checkpoint and nothing to survive the panel closing
- [ ] Decide whether an ask history survives a panel reopen. Default to React-local state (lost on
      close) unless there's a reason to persist — `PipelineRunState` in `lib/tabStore.ts` is keyed
      per tab and per run, which is the wrong shape for a surface that works with no run at all
- Build test-first, same as the rest

### Phase 10 — Live chat to refine drafted answers (not started)

In the side panel's review UI, let the user open a chat with the AI _about a specific drafted
answer_ and iterate on it conversationally ("make this shorter", "lead with the migration story
instead", "sound less formal") instead of only hand-editing the textarea. Scoped to
`question`-category fields only (the freeform drafted answers already in the review UI) — not
select/combobox/radiogroup fields, which are constrained-choice and not a good fit for freeform
rewriting. Manual textarea editing stays as-is; this is an additive alternative, not a replacement.

See the overlap warning in Phase 9: both are chat surfaces grounded in `profile`/`jobInfo`, and
which one owns the backend turn should be settled before either is built.

- [ ] `packages/shared`: add `ChatMessageSchema` (`role: 'user' | 'assistant'`, `content`) and a
      request/response shape for one chat turn (profile, jobInfo, question, current answer, prior
      `messages: ChatMessage[]` → assistant reply, plus an optional `revisedAnswer` string when the
      assistant's reply represents a concrete new draft rather than just conversation)
- [ ] `apps/backend/src/llm/chatAboutAnswer.ts` — one turn of the conversation; same model tier as
      `answerQuestions` (`MODELS.writing`, Sonnet), grounded in `profile`/`jobInfo` with the same
      non-fabrication rule as the rest of the answer-drafting prompts
- [ ] `POST /chat-answer` route — zod-validated body, returns `{ reply, revisedAnswer? }`
- [ ] Panel: a "Refine with AI" affordance per question card opening a small message-thread UI
      (history + input); when a reply includes `revisedAnswer`, a "Use this" action applies it to
      the existing answer textarea (still editable by hand afterward, same as today)
- [ ] Decide whether chat history survives a _panel reopen_ — i.e. whether it belongs on
      `PipelineRunState` in `lib/tabStore.ts` alongside the answers, or stays React-local. (The
      harder half of this question is already settled: the side panel was built for unrelated
      reasons, so the surface itself is persistent.)
- Build test-first, same as the rest

## Open cleanups

From the architecture-review runs. Everything **Strong** has been actioned; this is what's left.

- [ ] **Speculative:** `FILLABLE_FROM` constrains the _sequence_ a Fill Step may start from, not
      concurrency — it reads the status before an await, so two `START_FILL`s arriving in the same
      tick would both pass. Nothing dispatches them that way (the panel disables Fill on the
      optimistic `filling`, before the round trip), so this is parked rather than open. Closing it
      needs a compare-and-transition inside `withTabLock`, not a wider read in the pipeline.

- [ ] Every new Story is created with `id: ''`, but `QuestionAnswer.sourceStoryIds` references
      `Story.id` — so those references are useless whenever the candidate didn't type an id by hand.
      A behaviour change rather than a refactor, hence left alone; see `options/App.tsx`.
- [x] `profileRepository.saveProfile`'s upsert now has direct coverage
      (`db/profileRepository.test.ts`, against a stubbed Drizzle client), and both repositories parse
      jsonb rather than casting it — the two policies noted here are one. The upsert was also
      **rewritten**, which this item didn't ask for: it now runs a `WHERE`-less `UPDATE ... RETURNING`
      and inserts only when that touched nothing, instead of selecting first. One round trip rather
      than two on Neon's driver, and it relies on `profiles` holding exactly one row — the premise
      `getProfile`'s `limit(1)` already reads on. See the docblock for why no `WHERE`.
- [ ] **Speculative:** `tailorResume.ts` / `answerQuestions.ts` both hand-build the same
      `<base_profile>`/`<job_info>` prompt scaffold — extract a shared helper if a third
      writing-model call site appears (Phase 9 would be it).

## Known loose ends

- **There is no Ashby API oracle.** The one that existed only ever got 401s and was removed, along
  with its `api.ashbyhq.com` host permission. The unauthenticated GraphQL endpoint that _does_ work,
  its query and its response shape are written up in `background/apiDetectors.ts`'s own comment;
  rebuilding it needs `jobs.ashbyhq.com` in `host_permissions` and a POST body, which
  `AtsOracle.request` would have to start returning an `init` for again.
- **`packages/shared/src/screeningAnswers.ts` has no test file** — the only module in that package
  without one. `matchScreeningTopic`'s order-dependent matching (a question naming both work
  authorization and sponsorship must resolve to the former) is covered only indirectly, through
  `preparedAnswers`.
- ~~**A second non-autofilling form was mentioned but never supplied.**~~ Supplied and fixed: a
  Lever posting (`jobs.lever.co/sonarsource/…/apply`) that filled nothing at all. Detection was
  never the problem — `content/leverForm.test.ts` runs against the captured live form and finds and
  fills every field. The fault was in the frame plumbing, and it is not Lever-specific: both
  `SCAN_PAGE` and `FILL_FORM` are now addressed to the frame that reported the form rather than
  broadcast to the tab. See the `chrome.tabs.sendMessage` entry under _Constraints that look like mistakes_.
- **Nothing proves a Gem posting (`jobs.gem.com`) fills.** A detection fix was tried and reverted at
  the user's request because it did not fix the reported symptom. Gem is a fully client-rendered SPA
  whose inputs carry no `id`, `name`, `placeholder` or `<label>`; the untested suspicion is that its
  React-controlled inputs revert a written value, which would be a Fill Step problem rather than a
  detection one. Diagnosing it needs a live browser, not a captured snapshot.
- Two Ashby questions still need a live browser check: whether `data-djobi-id` attributes survive an
  Ashby form re-mount (if not, `resolveField` returns null for every field), and how Ashby renders
  its four Boolean screening questions — native fieldset/radios and `role="combobox"` are handled,
  custom buttons are not.
