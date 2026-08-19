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

Everything in this **Current state** section is built and tested; later sections explicitly mark
historical milestones and proposed work. Suite green at **688 tests** (120 shared / 109 backend / 394
extension / 65 dashboard), `pnpm test` from the repo root.

- **`packages/shared`** — the zod schemas and the rules both processes must agree on: `schemas.ts`
  (Profile, Job Info, Tailored Resume, Question Answer, Application), `detectedField.ts` (what a
  Detected Field is and how an answer gets back onto one), `wire.ts` (shared route contracts whose
  request/response shapes must stay aligned across consumers), `labelMatching.ts` (when two labels
  are the same), `screeningAnswers.ts` / `preparedAnswers.ts` (the facts a Profile answers without a
  model).
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
Every run has a unique id; asynchronous completions patch only that id, navigation clears the tab's
frames/run, and panel edits route through the service worker so every storage mutation shares one
per-tab queue. Fill and Save claim statuses atomically before starting.

The panel has two tabs. **Autofill** is that pipeline. **Log** records a job the candidate applied
to themselves — their own resume, or LinkedIn Easy Apply — so it still lands in the same history:
paste the posting and its URL, `POST /extract-job` for the details, then `POST /applications` with
`source: 'manual'` and the base profile in place of a tailored resume. No pipeline, no tab-scoped
run state, no Detected Fields and no page writes. Its URL field follows the active tab until the
candidate edits it.

## Key decisions

- **Models:** `claude-haiku-4-5` for job-info extraction, `claude-sonnet-5` for resume tailoring
  and question answering.
- **DB:** Postgres on Neon (cloud), accessed via Drizzle ORM. The backend itself runs locally.
  Duplicate Guard lookups use a `(job_url, created_at DESC)` index. PGlite integration tests execute
  the optimized query and singleton/index migrations against a PostgreSQL-compatible engine.
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
  `PATCH /applications/:id`, so re-filling or re-editing a run can't leave two rows behind. Saving
  neither submits the employer's form nor proves that the candidate submitted it separately.
- **The duplicate guard fails open.** A job URL already saved stops a run at `duplicate` before any
  LLM call, and the candidate can override with "Analyze and apply anyway". A lookup that _errors_
  counts as no duplicates — the guard exists to save the candidate from re-applying, not to make a
  stopped backend the reason Analyze doesn't work.
- **Application tracking is `stage` alone** (applied → phone_screen → interviewing → rejected).
  There was also a `status` field (draft/submitted) for "did this actually go out"; it was dropped
  in migration `0002` because nothing ever set `submitted` and the field was `draft` on all 28
  rows. The current Save Step does not establish whether employer submission happened. Notes are a
  timestamped, categorized log (`technical` / `behavioral` / `general`) you append to, not a single
  overwritable text field — so old interview-question notes stay around as reference for future
  applications.
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
  These verified counts exist only when the content script responds. If no frame answers, the run
  retains optimistic attempted counts but its outcome is `unverified`, never success.
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

## Milestones and plans

### Phase 7 — Application tracking data model (historical, done)

Stage/Note schemas, migration `0001_living_captain_stacy.sql`, `updateApplicationStage`,
`addApplicationNote`, `PATCH /applications/:id/stage` and `POST /applications/:id/notes`.

Tracking writes have their own routes rather than riding on `PATCH /applications/:id`, whose body is
an `ApplicationSnapshot` that deliberately excludes stage and notes — folding them in would let a
re-saved autofill stomp interview history.

### Phase 8 — Frontend dashboard (historical, done)

`apps/dashboard` on `localhost:5174`, wired to the backend: applications list with client-side
stage/search filtering and per-card stage editing, and a detail view with a stage picker, the notes
log and composer, and collapsed job info / tailored resume / drafted answers. `hono/cors` added to
`apps/backend/src/app.ts`, registered before the routes with the origin restricted to the
dashboard's dev URLs.

### Phase 9a — Log tab: record an application made by hand (historical, done)

A second tab in the side panel for jobs the candidate applied to without djobi. Migration
`0003_abandoned_sir_ram.sql` adds `applications.source` (`'autofill' | 'manual'`, defaulting to
`'autofill'` so every existing row and the extension's unchanged save path stay valid);
`baseResumeOf` in `packages/shared` projects a Profile into the `TailoredResume` shape, which is
possible because the latter is defined as a subset of the former. The dashboard badges manual rows
and relabels the resume section, since "Tailored resume" would be a false claim on them.

Decisions:

- **A tab, not a mode toggle on the existing flow.** The Log flow shares no state with the pipeline —
  no Detected Fields, page writes or `PipelineStatus` — so folding it in would mean threading a
  second meaning through every branch of `reviewOf`. Its form state is local, while its untouched URL
  prefill follows the active tab.
- **No new endpoints and no new LLM call.** `POST /extract-job` and `POST /applications` already do
  the work; only the `source` column is new.
- **`source` is omitted from `ApplicationSnapshotSchema`**, alongside `stage` and `notes`: a re-save
  must not be able to relabel how a record was created.
- **`jobUrl` stays required and `.url()`-validated.** It is the duplicate guard's key, so the Log tab
  makes it a required field rather than inventing a placeholder — and it runs the same
  already-applied check before writing, warning without blocking.

The URL is typed or follows the active tab until edited; the Log flow does not fetch the posting from
that URL. Reading a posting from a link, or off an open LinkedIn Easy Apply modal, is the larger
proposed feature sketched in
`docs/application-info-extraction-mode.md`.

### Phase 9 — Answer chat (done)

Merges what were separately proposed as Phase 9 (Ask tab) and Phase 10 (refine a drafted answer).
One chat surface, one route, one LLM module. Asking cold and refining an existing draft are the same
conversation with a different starting state — building them apart would have put two chat
implementations in one panel.

The gap it closes: answer drafting only ever fires for `question`-category fields the detector found
on the page. A question the detector missed, one on a page the extension can't see, or one from a
form the candidate is filling elsewhere has no path to an answer today. And a drafted answer that is
_nearly_ right can only be hand-edited in a textarea.

Decisions:

- **One chat UI: the Ask tab.** `panel/App.tsx` already switches between **Autofill** and **Log**;
  Ask becomes a third tab, reachable at any point in a run — including `ready`, when there is no run
  at all. The review card does not grow its own thread. Its "Refine with AI" button switches to the
  Ask tab seeded with that question and its current draft, and the tab offers "Use this answer",
  which writes back to the run's answer (still hand-editable afterward, same as today).
- **One route.** `POST /answer-chat` serves every turn. Cold ask and refinement differ only in the
  request body — whether `currentAnswer` is set and whether `messages` is empty — never in the
  server.
- **Grounded in the Profile; nothing else is required.** `jobInfo` is optional, because the Ask tab
  must work with no detected job page. When the panel has a run with `jobInfo`, pass it so the answer
  is tailored.
- **Same non-fabrication rule as everywhere else.** The answer may only use what the Profile
  supports. This surface must not become the one place the model is allowed to invent experience.
- **`revisedAnswer` is what the user applies; `reply` is what the thread shows.** A turn may be pure
  conversation ("which of these two stories do you want?"), so `revisedAnswer` is optional — except
  on a cold turn (no prior messages, no `currentAnswer`), where the prompt requires one, since a
  fresh ask has nothing else to display.
- **Write-back only exists for a seeded thread.** "Use this answer" appears when the thread was
  opened from a question card; a cold ask has no field to write to and gets a copy button instead.
  This phase adds no new path from a drafted answer onto the page — filling stays the Fill Step's
  job, from detected fields.
- **Seeding is scoped to `question`-category fields only** — not select/combobox/radiogroup, which
  are constrained-choice and a poor fit for freeform rewriting.

- [x] `packages/shared/src/wire.ts`: `ChatMessageSchema` (`role: 'user' | 'assistant'`, `content`)
      and the `/answer-chat` contract — body of `profile`, `question`, optional `jobInfo`, optional
      `currentAnswer`, and `messages: ChatMessage[]` (empty on a cold ask); response
      `{ reply, revisedAnswer? }`, built against by `lib/backendClient.ts` via `satisfies`
- [x] `groundingContext` in `apps/backend/src/llm/promptContext.ts` — the `<base_profile>` /
      `<job_info>` scaffold `tailorResume.ts` and `answerQuestions.ts` each hand-built, now one
      helper all three call sites use. `jobInfo` is optional there, which is what this phase needed
- [x] `apps/backend/src/llm/answerChat.ts` — one turn through `structuredCall.ts`; `MODELS.writing`
      (Sonnet), same tier and grounding rules as `answerQuestions`
- [x] `POST /answer-chat` route — zod-validated against the wire schema
- [x] `lib/backendClient.ts`: `answerChat` on `BackendClient` and `httpBackendClient`
- [x] `panel/App.tsx`: "Ask" alongside "Autofill" / "Log", and the review card's "Refine with AI"
      hand-off (question + current answer + field id, plus a token so re-seeding the same card
      starts a fresh thread)
- [x] `panel/AskTab.tsx` — question box, message thread, follow-up input, in-flight and error
      states, a copy button, and "Use this answer" for a seeded thread

Two things settled while building:

- **The thread the panel sends alternates and ends with the candidate's turn — nothing is said
  about its first turn.** The scaffold (Profile, Job Info, the question, the draft) _is_ the
  conversation's opening user turn, so a cold ask's thread starts with the assistant, while a
  seeded one starts with the candidate's instruction. `answerChat` folds a leading user turn into
  the scaffold rather than sending it after — the Messages API refuses two user turns in a row.
  The rule is enforced in the wire schema, so a malformed thread is a 400 here and not an opaque
  provider 500.
- **The thread does not survive a panel reopen** (the open question above). Persisting only seeded
  threads would make "is my conversation still here" depend on where it started; the rule the
  candidate can actually hold is that the _answer_ applied to the run survives and the conversation
  doesn't. `PipelineRunState` is keyed by tab, which a cold ask has no business being.
- Built test-first, same as the rest

### Architecture pass — the panel's seams (done)

Four candidates from an architecture review of the panel, after the Ask Tab landed and `panel/App.tsx`
had grown to 694 lines.

- [x] **The Autofill Tab is a module.** `panel/AutofillTab.tsx` holds the flow; `panel/App.tsx` is a
      shell owning the Profile bootstrap, the tab switch, the Ask hand-off and the header pill.
      `panel/useActiveRun.ts` owns the run for the page being shown — including the navigation-race
      rule that used to sit between two hook calls in the shell, and `updateAnswer`, which two tabs
      perform. `panel/AutofillTab.test.tsx` carries the flow's cases;
      `panel/panelTestHarness.ts` is the fake both halves share.
- [x] **The panel goes through `BackendClient`.** `main.tsx` (panel and options) is now the only
      place either page names `httpBackendClient`; every module below takes the client it is given.
      `createFakeBackendClient` in `lib/backendClient.ts` is the test adapter — the extension's
      counterpart to the Dashboard's `createFixtureDashboardClient`. No UI test names a backend path
      any more, which is what they used to assert on.
- [x] **`panel/useResumePreview.ts`.** The blob-URL lifecycle — render, show, revoke exactly once,
      and ignore a completion that has been superseded — behind three names.
- [x] **`lib/fakeChrome.ts`.** One fake for `chrome.tabs` / `runtime` / `storage.session`,
      composing `fakeSessionStorage`. Used by the panel harness, `useActiveTab`, `usePipelineRun`
      and `tabStore` tests. Deliberately not universal: `useActiveTab`'s _deferred_ fake (which
      interleaves callbacks to pin activation/navigation races) and the page-side fakes in
      `content/index.test.ts` and `lib/pageClient.test.ts` (`runtime.onMessage`, `tabs.sendMessage`,
      `scripting`) stay their own, because folding them in would widen the interface past what any
      caller wants.

### Phase 10 — Bullet selection: an unbounded bullet bank, capped per resume (proposed, not started)

Let the candidate keep **every** bullet they have ever written for a role, and make `tailorResume`
choose which of them belong on _this_ resume by weighing each against the posting's requirements —
up to a bullet count the candidate controls.

Today the model rewords and reorders bullets but is never told to _drop_ any, so every bullet on a
role lands on every resume. That makes the base profile a document the candidate has to keep
pruned by hand, and it is what pushes a resume off one page: `renderResume.tsx` walks a density
ladder to fit, and when the tightest step still spills it returns two pages, with its own comment
naming the real fix as a content problem belonging upstream in `llm/tailorResume.ts`. This is that
fix.

Decisions:

- **The bullet cap is a maximum, never a target.** A role with three bullets under a cap of six
  stays at three. Padding to reach a number is fabrication, which the tailoring prompt already
  forbids — the two rules must not be allowed to fight.
- **The model returns the index of the source bullet it chose, not just prose.** Selection and
  rewording in one step are otherwise unverifiable: given only strings back, the backend cannot tell
  a legitimately reworded selection from a silently invented bullet or a miscounted one. With
  `{ sourceIndex, text }`, `reconcileResume` verifies every kept bullet traces to a real profile
  bullet, drops any out-of-range index, and **enforces the cap in code** rather than trusting the
  prompt to have obeyed it.
- **`sourceIndex` is a detail of the model call and is not persisted.** `reconcileResume` resolves
  it away and still returns plain `string[]`, so `TailoredResumeSchema`, the stored
  `Application.tailoredResume`, the PDF renderer and the dashboard all stay exactly as they are.
  Only the tool schema inside `tailorResume.ts` carries the indices.
- **The cap does not replace the density ladder.** The cap governs how much content there is; the
  ladder governs the typography for whatever survives. Both stay. The two-page fallback should
  simply become rare.
- **Dropped bullets are shown as dropped.** The review UI reports what was left off (at minimum a
  count per role) rather than silently presenting a shortened resume as the whole of it. Losing
  content the candidate wrote without telling them is the failure mode the PDF renderer already
  refuses to commit; a deliberate drop is fine, an invisible one is not.
- **A manually logged application is not capped.** `baseResumeOf` projects the Profile with nothing
  dropped, because a `source: 'manual'` record documents what the candidate actually sent. Capping
  is a tailoring decision and belongs only on the tailoring path.
- **Nothing today blocks an unbounded bullet bank.** `WorkExperienceSchema.bullets` is an uncapped
  `z.array(z.string())` and the options page's "+ Add bullet" is unbounded, so the storage half of
  this phase already works. The work is the selection and the cap — plus whatever the options page
  needs to stay usable once a role holds fifteen bullets instead of four.

- **One Profile-level default, overridable per role.** `Profile.maxBulletsPerRole` sets the cap for
  every role; a `WorkExperience.maxBullets` of `null` inherits it and a number overrides it. Recent
  roles usually deserve more lines than a job from a decade ago, and a single flat number cannot
  express that — but making every role carry its own required number is a fussier form for no gain
  on the common case.
- **The cap lives on the Profile, not on the run — for now.** It is a persisted preference applying
  to every application, added as an optional field with a schema default exactly as
  `screeningAnswers` was, so stored profiles keep parsing with no migration. A per-application
  override in the panel is a plausible later addition and is deliberately not built here; nothing in
  this shape blocks it.

- [ ] `packages/shared/src/schemas.ts`: `Profile.maxBulletsPerRole` (optional, schema default) and
      `WorkExperience.maxBullets` (nullable, `null` = inherit); add both to `EMPTY_PROFILE`
- [ ] Keep `maxBullets` out of the _resume_. Adding it to `WorkExperienceSchema` puts it on two
      paths that hand a Profile's entries straight to a `TailoredResume`: `baseResumeOf` returns
      `profile.workExperience` as-is, and `reconcileResume` spreads the whole profile entry
      (`{ ...profileByKey.get(key)!, bullets }`). Neither re-parses, so the cap would ride into
      `applications.tailoredResume` jsonb as a stored field of a resume, where it means nothing.
      Project the entry explicitly in both places instead of spreading
- [ ] `apps/backend/src/llm/tailorResume.ts`: tool schema returns `{ sourceIndex, text }` per bullet;
      prompt instructs selection against `jobInfo.requirements`/`keywords`, states the cap as a
      maximum, and forbids padding
- [ ] `reconcileResume`: resolve `sourceIndex` against the profile entry's own bullets, drop
      unresolvable ones, truncate to the cap, and return plain `string[]` — the existing entry-level
      reconciliation is unchanged
- [ ] Options page: the cap control(s), and a bullet editor that stays workable at fifteen bullets
      per role
- [ ] Panel review UI: surface what was dropped per role
- [ ] Confirm the two-page case actually recedes — a fixture that previously spilled should now fit
- Build test-first, same as the rest

## Open cleanups

From the architecture-review runs. Everything **Strong** has been actioned; this is what's left.

- [x] Fill and Save claim their run through `transitionPipelineRun`, an atomic status
      compare-and-transition inside `withTabLock`, so concurrent commands cannot both start.

- [x] New Stories receive a generated UUID by default, so `QuestionAnswer.sourceStoryIds` remains
      useful even when the candidate does not replace the editable id.
- [x] `profileRepository.saveProfile` has direct coverage (`db/profileRepository.test.ts`, against a
      stubbed Drizzle client). It atomically inserts the singleton's fixed ID and uses
      `ON CONFLICT (id) DO UPDATE`; `getProfile` selects that same ID. Profile jsonb is parsed rather
      than cast, so fields with explicit schema defaults are repaired on read and malformed required
      data fails at the repository boundary.
- [ ] `tailorResume.ts` / `answerQuestions.ts` both hand-build the same
      `<base_profile>`/`<job_info>` prompt scaffold. This was held as speculative pending a third
      writing-model call site; Phase 9's `answerChat.ts` is that site, so the extraction is now a
      step of that phase rather than an open question.

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
