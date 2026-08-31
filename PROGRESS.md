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

Everything in this **Current state** section is built and tested, as is everything under
**Shipped**; only **Planned** describes work that doesn't exist yet. Suite green at **1108 tests** (182 shared / 15 http-client / 186 backend / 608
extension / 117 dashboard), `pnpm test` from the repo root. A green run prints nothing: every
deliberate log line a failure path writes is either asserted or silenced where it is expected, so
anything that does appear is a surprise. CI (`.github/workflows/ci.yml`) runs
`format:check`, `typecheck`, `build` and `test` on Linux for every PR and every push to `main`.

- **`packages/shared`** — the zod schemas and the rules both processes must agree on: `schemas.ts`
  (Profile, Job Info, Tailored Resume, Question Answer, Application), `detectedField.ts` (what a
  Detected Field is and how an answer gets back onto one), `wire.ts` (shared route contracts whose
  request/response shapes must stay aligned across consumers), `labelMatching.ts` (when two labels
  are the same), `screeningAnswers.ts` / `preparedAnswers.ts` (the facts a Profile answers without a
  model), `jobKey.ts` (a posting's URL identity, which both sides must derive identically), and
  `resumeFileName.ts`.
- **`apps/backend`** — Hono on `127.0.0.1:5391`. Four LLM calls (`extractJob`, `tailorResume`,
  `answerQuestions`, `answerChat`) through `structuredCall.ts` — one seam over
  the Vercel AI SDK and OpenRouter, routed per operation by `client.ts`'s `MODELS` — all grounded by
  one `promptContext.ts` scaffold — each grounded in a Profile _projection_ the operation parses
  from `wire.ts` rather than restating, so widening one is a deliberate disclosure change; a
  one-page-fitting resume PDF renderer, and
  Postgres persistence (Neon + Drizzle) for profiles and applications. `pnpm --filter backend
build` compiles the shared package and emits a plain-Node production server to `dist/`.
- **`apps/dashboard`** — Vite + React on `localhost:5174`, browsing past Applications and tracking
  their Stage and Notes against the live backend. Two views behind a hand-rolled hash router; one
  `DashboardClient` seam (`lib/dashboardClient.ts`) whose fixture implementation is test-only, so
  every view is exercised without a network while the running app always talks to Postgres.
- **`apps/extension`** — MV3, Vite + `@crxjs/vite-plugin` + React. Content scripts detect the form
  (`detect.ts`) and classify its fields (`detectFields.ts`) and fill them (`fillForm.ts`); the
  service worker (`background/service-worker.ts` → `background/router.ts`) runs the pipeline
  (`applicationPipeline.ts`, each step held by `background/runClaim.ts`); the options page edits the
  Profile; the side panel is the review surface, sending its three commands through
  `panel/pipelineCommands.ts` and holding one conversation in `panel/useAskThread.ts`. A tab's
  stored record is one entry under one lock behind four focused interfaces (`lib/tabStore/`). Light/dark theme shared by both pages (`lib/theme.tsx`), persisted in
  `chrome.storage.local`.

The Application Pipeline as it runs today: **scrape or paste a job description → duplicate guard →
Analysis Step → review and edit → Fill Step → explicit Save Step.** The panel is hydrated from and
checkpointed to `lib/tabStore/` at every stage, so closing it mid-run loses nothing.
Every run has a unique id; asynchronous completions patch only that id, and every step takes the run
through one claim (`background/runClaim.ts`) that owns acquisition, supersession, checkpointing and
release — with cancellation a per-step policy, since the Save Step's write cannot be safely aborted. Navigation always clears
page-specific frames, but the Job Context and run survive when the URL still identifies the same
job (including Ashby `/application`). Panel edits route through the service worker so every storage
mutation shares one per-tab queue. Fill and Save claim statuses atomically before starting.

**The worker is assumed to be killable at any point**, since MV3 says it is. Three rules cover that,
and the reasoning is under _MV3 durability_ below: a command Chrome couldn't deliver stands
the panel's optimistic state back down instead of leaving it spinning; a failure that can't even be
checkpointed reaches a logging boundary rather than vanishing into a fire-and-forget promise; and a
new worker's first act is to turn any `analyzing`/`filling`/`saving` its predecessor abandoned into a
retryable error.

The panel has three tabs. **Autofill** is that pipeline. **Log** records a job the candidate applied
to themselves — their own resume, or LinkedIn Easy Apply — so it still lands in the same history:
paste the posting and its URL, `POST /extract-job` for the details, then `POST /applications` with
`source: 'manual'` and the base profile in place of a tailored resume. No pipeline, no tab-scoped
run state, no Detected Fields and no page writes. Its URL field follows the active tab until the
candidate edits it. **Ask** drafts or revises one application answer without writing to the page.

## Key decisions

- **Models:** multi-provider through the Vercel AI SDK and OpenRouter, routed **per operation**
  rather than by vendor tier. `google/gemini-3.1-flash-lite` serves `extractJob`;
  `anthropic/claude-sonnet-5` serves `tailorResume`, `answerQuestions` and `answerChat`, the three
  calls where written judgement is the product. The map lives in `llm/client.ts` as `MODELS`, so a
  reroute is an edit to one object. There is no dual-client fallback path, deliberately: that is a
  code path with no test coverage waiting to be wrong. Anthropic model slugs prefer the `anthropic`
  upstream and may fall back only to `claude-on-aws`; every call logs its resolved upstream and its
  cost, so the routing is revisable with numbers rather than argument.
- **DB:** Postgres on Neon (cloud), accessed via Drizzle ORM. The backend itself runs locally.
  Duplicate Guard lookups match a derived `job_key` — the posting's URL identity — backed by a
  `(job_key, created_at DESC)` index, falling back to `(job_url, created_at DESC)` for rows written
  before the key existed. PGlite integration tests execute the optimized query and singleton/index
  migrations against a PostgreSQL-compatible engine.
- **Structured output is the response format, and the local parse is still the guarantee.** Every
  LLM call goes through `generateObject` with its zod schema — see
  `apps/backend/src/llm/structuredCall.ts` — and the object is re-validated against that schema
  before it is returned. That re-validation is not redundant: OpenRouter's structured-output support
  varies by model **and** by which upstream serves it, so calls route with
  `provider: { require_parameters: true }` to make incompatible hosts ineligible — the provider
  promise is the optimization, the local parse is the guarantee. `strict` is off, since these schemas use
  optional and defaulted fields that its subset forbids; the four schemas must instead stay inside
  the JSON Schema subset **every** route can serve. No hand-maintained JSON Schema mirrors exist; if
  one appears, it's a regression.
- **Prompt order keeps caching possible.** `cachedPrefix` means stable text first, varying text last.
  `answerQuestions` preserves that ordering, while structured-call metrics report whether the
  selected provider actually served cache reads.
- **Form filling:** one generic heuristic field-classifier, not per-ATS selectors. ATS platform
  APIs are used as an _oracle_ (classification, required, options) where one exists; the DOM stays
  the targeting mechanism. See `background/apiDetectors.ts`.
- **The Analysis Step reports what it produced, and never rewrites toward the report.**
  `extractJob` emits `requirements` and `keywords`, and `tailorResume` is told to emphasize them.
  **Keyword Coverage** (`packages/shared/src/keywordCoverage.ts`) checks the resulting resume
  deterministically, whole-word via `containsAsWords`, with no model call or added latency. It never
  feeds back into tailoring, and that is the load-bearing part: `reconcileResume` copies every skill
  from the Profile unchanged, so the model cannot add, remove, or reorder skills to improve the
  report. The only true remedy for a gap is the Profile. It is rendered as a gap list rather than a
  score, because a number on screen is a number someone will raise, and the only way to raise this
  one dishonestly is keyword stuffing. The "ATS rejects below an X%
  keyword match" framing is **folklore**; what coverage actually buys is recruiter search hits, the
  6–10 second human scan, and employer-configured filters.
- **Scraping is explicit, focused, and reviewable.** `Scrape job description` prefers schema.org
  `JobPosting`, then scores semantic DOM candidates across frames, strips forms/navigation, and fails
  closed below its confidence threshold. It populates the editable Job Description but never starts
  Analysis. Manual paste remains the fallback.
- **Job Context outlives an ATS screen, not a job.** The draft, original posting URL and run survive
  same-job routes such as Ashby Overview → Application; form frames are always discarded and
  re-detected. A different job URL or tab closure clears the retained state.
- **Review surface is a side panel, not a popup.** A popup is destroyed on any outside click; the
  panel survives tab switches, and the pipeline runs in the service worker so closing the panel
  mid-run doesn't drop the result.
- **Saving is explicit and separate from filling.** The Fill Step writes the page; the Save Step
  records the Application. The first save creates the record and every later one updates it via
  `PATCH /applications/:id`, so re-filling or re-editing a run can't leave two rows behind. Saving
  neither submits the employer's form nor proves that the candidate submitted it separately.
- **The duplicate guard fails open.** A posting already saved stops a run at `duplicate` before any
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
- **A new Story gets a generated UUID by default.** The id is editable, but
  `QuestionAnswer.sourceStoryIds` is only useful if it points at something — so it must not depend
  on the candidate having replaced a placeholder.
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
  fed by `getDetectedFrame` in `lib/tabStore/`). Without it the runtime delivers to _every_ frame
  and resolves with whichever answers first, dropping the rest — and the content script is injected
  into all frames, third-party ones included. A page carrying an invisible hCaptcha or a
  tag-manager pixel therefore had those frames answering `FILL_FORM` with an empty result before
  the frame owning the form finished verifying its writes, so the Fill Step reported "nothing
  filled" regardless of what happened. `content/index.ts` staying silent on `FILL_FORM` in frames
  holding none of the fields is the backstop, and mirrors the same rule `SCAN_PAGE` already
  followed. Collapsing either back to a broadcast reintroduces the bug silently.

## Shipped — decisions still in force

Why the built surfaces are shaped the way they are. The task lists that produced them are in git;
what's kept here is the reasoning a later change would otherwise have to re-derive.

### Application tracking writes

`PATCH /applications/:id/stage` and `POST /applications/:id/notes` are their own routes rather than
fields on `PATCH /applications/:id`, whose body is an `ApplicationSnapshot` that deliberately
excludes stage and notes. Folding them in would let a re-saved autofill stomp interview history.

### Bullet reconciliation by source index

`tailorResume` does not ask the model for resume prose. It returns
`{ sourceIndex, bullets: [{ sourceIndex, text }] }` per role, and `reconcileResume` rejoins that to
the authoritative Profile: company, title and dates come from the Profile, skills are copied
unchanged, and every kept bullet must trace to a real profile bullet. Selection and rewording in one
step are otherwise unverifiable — given only strings back, the backend cannot tell a legitimately
reworded bullet from a silently invented one.

Invalid pointers are treated as a malformed result, never as an instruction: a duplicate or
out-of-range role index falls back to Profile order, and a role whose bullets all fail to resolve
keeps its original bullets rather than being emitted empty. Bullets may already be reordered and
omitted; what does not exist yet is any _cap_ on how many survive, which is Phase 10 below.

### The Log tab

- **A tab, not a mode toggle on the existing flow.** The Log flow shares no state with the pipeline —
  no Detected Fields, page writes or `PipelineStatus` — so folding it in would mean threading a
  second meaning through every branch of `reviewOf`. Its form state is local, while its untouched URL
  prefill follows the active tab.
- **No new endpoints and no new LLM call.** `POST /extract-job` and `POST /applications` already do
  the work; only the `source` column was new (migration `0003_abandoned_sir_ram.sql`, defaulting to
  `'autofill'` so every existing row and the extension's unchanged save path stay valid).
- **`source` is omitted from `ApplicationSnapshotSchema`**, alongside `stage` and `notes`: a re-save
  must not be able to relabel how a record was created.
- **`jobUrl` stays required and `.url()`-validated.** It is the duplicate guard's key, so the Log tab
  makes it a required field rather than inventing a placeholder — and it runs the same
  already-applied check before writing, warning without blocking.
- **A manual row stores the Base Resume, not a tailored one.** `baseResumeOf` projects the Profile
  into the `TailoredResume` shape — possible only because the latter is defined as a subset of the
  former — and the dashboard relabels that section on manual rows, since "Tailored resume" would be
  a false claim there.

The Log flow does not fetch the posting from the URL it stores. Reading a posting the extension
isn't looking at — from a link, or off an open LinkedIn Easy Apply modal — is the larger proposed
feature sketched in `docs/application-info-extraction-mode.md`.

### The Ask tab

The gap it closes: answer drafting only ever fires for `question`-category fields the detector found
on the page. A question the detector missed, one on a page the extension can't see, or one from a
form the candidate is filling elsewhere had no path to an answer. And a drafted answer that was
_nearly_ right could only be hand-edited in a textarea.

- **One chat UI, one route, one LLM module.** Asking cold and refining an existing draft are the
  same conversation with a different starting state; building them apart would have put two chat
  implementations in one panel. `POST /answer-chat` serves every turn, and the two differ only in
  the request body — whether `currentAnswer` is set and whether `messages` is empty — never in the
  server.
- **Ask is a third tab, reachable at any point in a run** — including `ready`, when there is no run
  at all. The review card does not grow its own thread: its "Refine with AI" button switches to the
  Ask tab seeded with that question and its current draft.
- **Grounded in the Profile; nothing else is required.** `jobInfo` is optional, because the Ask tab
  must work with no detected job page. When the panel has a run with `jobInfo`, it passes it.
- **Same non-fabrication rule as everywhere else.** The answer may only use what the Profile
  supports. This surface must not become the one place the model is allowed to invent experience.
- **`revisedAnswer` is what the user applies; `reply` is what the thread shows.** A turn may be pure
  conversation ("which of these two stories do you want?"), so `revisedAnswer` is optional — except
  on a cold turn (no prior messages, no `currentAnswer`), where it is required, since a fresh ask
  has nothing else to display.
- **Write-back only exists for a seeded thread.** "Use this answer" appears when the thread was
  opened from a question card; a cold ask has no field to write to and gets a copy button instead.
  There is no path from a drafted answer onto the page here — filling stays the Fill Step's job,
  from detected fields.
- **Seeding is scoped to `question`-category fields only** — not select/combobox/radiogroup, which
  are constrained-choice and a poor fit for freeform rewriting.
- **The thread the panel sends alternates and ends with the candidate's turn — nothing is said about
  its first turn.** The scaffold (Profile, Job Info, the question, the draft) _is_ the conversation's
  opening user turn, so a cold ask's thread starts with the assistant while a seeded one starts with
  the candidate's instruction. `answerChat` folds a leading user turn into the scaffold rather than
  sending it after — the Messages API refuses two user turns in a row. The rule is enforced in the
  wire schema, so a malformed thread is a 400 here and not an opaque provider 500.
- **The thread does not survive a panel reopen.** Persisting only seeded threads would make "is my
  conversation still here" depend on where it started; the rule the candidate can actually hold is
  that the _answer_ applied to the run survives and the conversation doesn't. `PipelineRunState` is
  keyed by tab, which a cold ask has no business being.

### The panel's seams

- **The Autofill Tab is a module.** `panel/AutofillTab.tsx` holds the flow; `panel/App.tsx` is a
  shell owning the Profile bootstrap, the tab switch, the Ask hand-off and the header pill.
  `panel/useActiveRun.ts` owns the run for the page being shown — including the navigation-race rule
  and `updateAnswer`, which two tabs perform. `panel/panelTestHarness.ts` is the fake both halves
  share.
- **The panel goes through `BackendClient`.** `main.tsx` (panel and options) is the only place
  either page names `httpBackendClient`; every module below takes the client it is given.
  `createFakeBackendClient` in `lib/backendClient.ts` is the test adapter — the extension's
  counterpart to the Dashboard's `createFixtureDashboardClient`. No UI test names a backend path.
- **`panel/useResumePreview.ts`** holds the blob-URL lifecycle — render, show, revoke exactly once,
  and ignore a completion that has been superseded — behind three names.
- **`lib/fakeChrome.ts`** is one fake for `chrome.tabs` / `runtime` / `storage.session`, composing
  `fakeSessionStorage`. Deliberately not universal: `useActiveTab`'s _deferred_ fake (which
  interleaves callbacks to pin activation/navigation races) and the page-side fakes in
  `content/index.test.ts` and `lib/pageClient.test.ts` stay their own, because folding them in would
  widen the interface past what any caller wants.

### MV3 durability — a worker that can be killed mid-step

MV3 gives no guarantee that the service worker survives an operation it started. The pipeline was
already checkpointed into `lib/tabStore/`, so nothing was ever _lost_ — but three ways of getting
stuck had no handling, and all three ended the same way for the candidate: a panel showing
`analyzing` forever, with no error and no retry.

- **A new worker repairs what the last one abandoned.** `recoverInterruptedPipelineRuns` in
  `lib/tabStore/` sweeps every `tab:<id>` entry and turns `analyzing`/`filling`/`saving` into the
  matching `*-error`, with a message saying what may have half-happened — fill says to check the
  application page, save says to check the Dashboard, because those two may have landed. It needs
  **no timeout**: an in-progress status already present when a worker starts necessarily belonged to
  the instance Chrome stopped. Each repair is a status compare-and-transition, so idle runs are
  untouched and the rule stays atomic with every normal pipeline claim.
- **One barrier, not a sweep per message.** `background/service-worker.ts` registers its listener
  synchronously (Chrome requires that) but routes every message behind the single recovery promise.
  Without one shared barrier a sweep can read `analyzing` that _this same worker_ has just written,
  and demote live work as interrupted.
- **A failure that can't be checkpointed still surfaces.** `checkpointFailure` in
  `applicationPipeline.ts` wraps the `patchPipelineRun` that records a step's failure; if that
  storage write itself rejects, it throws an `AggregateError` carrying both causes rather than
  losing the original. `runAnalysis`'s pre-backend work — reading the detected page, the Duplicate
  Guard lookup — sits inside that `try` for the same reason.
- **`handleTypedMessage` returns its task — but not to Chrome.** The service worker deliberately
  does not hand the promise back, so the protocol stays notification-only and never holds a closing
  panel's channel open. It is returned so there is one place, the listener's `.catch`, where a
  runner rejection is logged with the message type, tab and run id instead of being swallowed by a
  `void`.
- **An undelivered command stands the panel back down.** `notify` takes an optional
  `onDispatchError`, called when `chrome.runtime.lastError` says Chrome never delivered the START.
  The Autofill Tab renders that as the step's own error state and clears it as soon as any persisted
  progress for the run arrives — usually there is none, but a worker coming back mid-report is the
  race the guard exists for. This adds no response payload: the protocol still has no replies.

## Planned

### Phase 11 — Multi-provider models: Vercel AI SDK + OpenRouter (done)

Suite green, and all four schemas verified against real providers. The writing routes have since
moved to Sonnet 5, so their previous latency and cost measurements must be rerun before being used
for planning.

The live pass found two failures that no unit test could have, both created by this phase:

- **`answerQuestions` returned nothing, successfully.** `answer` was optional in the model schema —
  correct when one call answered a whole form, since a missing answer had to cost one item rather
  than discard its siblings. Fanning out removed the siblings, and a live provider took the option:
  `{"fieldId":"q1","sourceStoryIds":[...]}` with no answer, which validated, reconciled to zero
  answers, and reported success. Required now, so the same omission is an `invalid-input` that says
  so. Anthropic's `strict: true` had been masking this by filling the field regardless.
- **`tailorResume` truncated mid-object.** Reasoning counts against `max_tokens` here, and it is a
  near-constant 1.3k–2.3k floor while the object itself is 179–330 tokens — so the old per-bullet
  ladder was budgeting the half that barely grows. A 5-bullet profile hit its 2336 ceiling and came
  back `finishReason: 'length'`. That reserve was later removed after reasoning was explicitly
  disabled for this latency-sensitive call.

Stop being a single-vendor codebase. Replace the `@anthropic-ai/sdk` client with the **Vercel AI
SDK** talking to **OpenRouter**, and route each of the four calls to the model that suits it rather
than to a cheap/expensive tier of one vendor.

Initial routing:

| Call              | Model                          | Why                                                                                                                                                                                       |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extractJob`      | `google/gemini-3.1-flash-lite` | Highest call volume — every job, every Log-tab entry, and the serial gate for the whole Analysis Step. Near-free, and the task is transcription from text that is already in front of it. |
| `tailorResume`    | `anthropic/claude-sonnet-5`    | The one call where nuance is the product.                                                                                                                                                 |
| `answerQuestions` | `anthropic/claude-sonnet-5`    | Freeform prose grounded in Stories; the same judgement as tailoring.                                                                                                                      |
| `answerChat`      | `anthropic/claude-sonnet-5`    | Same drafting task as `answerQuestions`, in a conversation.                                                                                                                               |

Decisions:

- **One seam changes, not four call sites.** `structuredCall.ts` is the only module that names a
  provider today, and it stays that way: `callStructured`'s options (`model`, `maxTokens`, `effort`,
  `userContent`, `cachedPrefix`, `followUpTurns`, `toolName`, `schema`, `signal`) and its
  `StructuredCallError` contract are what the routes and `applicationPipeline` are written against.
  The body swaps to `generateObject`; the interface does not move. If this phase ends with a
  provider name outside `llm/client.ts` and `llm/structuredCall.ts`, it went wrong.
- **`client.ts` becomes a model registry, not two constants.** `MODEL`/`FAST_MODEL` are a
  vendor-tier split and stop meaning anything across providers. Replace them with a map from
  _operation_ to model id, so routing is data one file holds — the thing this phase exists to make
  changeable.
- **Model ids are OpenRouter slugs, and they must be verified live before wiring.** A wrong slug is
  a 404 at request time, not a type error, and both names above are shorthand rather than slugs.
  Resolve them against OpenRouter's model list as the first task, and pin the exact strings.
- **Structured output stops being a forced tool call.** `generateObject` picks each provider's own
  mechanism. The risk this trades into: OpenRouter's structured-output support varies by model _and_
  by which upstream serves it — a request can land on a host that ignores `response_format`.
  Route with `provider: { require_parameters: true }` so only upstreams that honour the schema are
  eligible, and **keep the zod re-validation and the one retry regardless** — the provider promise is
  the optimization, the local parse is the guarantee.
- **`strict: true` retires along with the Anthropic tool path.** That removes the two open
  code-review findings (`minLength` from `z.string().min(1)` in `ColdTurnOutputSchema`, and
  `JobInfoSchema`'s `["string","null"]` type arrays) instead of fixing them — but the class of
  problem returns, because every provider takes a different JSON Schema subset. Keep the four
  schemas inside the common subset and make one live call against each before the phase closes.
  Schema-generation unit tests catch a regression; only a live call catches an unsupported keyword.
- **`cachedPrefix` keeps stable text first.** This preserves the byte-identical leading prefix that
  provider-side caches can recognize, while usage metrics remain the source of truth for whether a
  selected route actually produced cache reads.
- **`effort` is Anthropic-specific and must be remapped, not silently dropped.** It becomes
  OpenRouter's `reasoning: { effort }`, and the mapping lives in `structuredCall.ts` beside the model
  registry. `tailorResume` initially remained its only caller, but live measurement showed medium
  effort dominating Analysis Step latency. Leaving it absent still enabled slow adaptive reasoning,
  so tailoring now explicitly selects `none`.
- **`max_tokens` accounting changes, and `tailorResume`'s limit must be re-derived against the new
  model.** `outputTokenLimit`'s ladder was sized for a model whose thinking tokens count against the
  same budget. Re-measure rather than port the numbers; a truncated generation is a failed Analysis
  Step, not a short resume.
- **Cost and latency get logged, so the routing above can be judged instead of argued.** Keep the
  `[djobi] structured_call` line and add provider, resolved upstream and cost — OpenRouter returns
  all three with `usage: { include: true }`. The point of this phase is that tiering becomes a
  decision someone can revisit with numbers.
- **Anthropic stays reachable through the same client.** OpenRouter serves Claude, so putting one
  call back on `anthropic/claude-*` is a registry edit rather than a second SDK. No dual-client
  fallback path is built; that is a code path with no test coverage waiting to be wrong.
- **`ANTHROPIC_API_KEY` → `OPENROUTER_API_KEY`.** One key and one meter for every model, which is
  also the shape the multi-tenant phase needs: "one server-side key funds every signup" becomes one
  bill to quota rather than one per vendor.
- **Tests move to the AI SDK's own fake, behind the unchanged `client.js` seam.** Every LLM test
  currently mocks `./client.js` as `{ anthropic: { messages: { create } } }`; they re-point to
  `MockLanguageModelV4` from `ai/test` (v2 was the guess; `ai@7` ships v3 and v4, and the OpenRouter
  provider implements v4). The seam is already in the right place — this is a mechanical swap of
  what the fake is, not of where it sits.

- [x] Slugs pinned: `google/gemini-3.1-flash-lite` and `anthropic/claude-sonnet-5`. OpenRouter
      advertises structured-output support for Sonnet 5, while `require_parameters` remains
      load-bearing because compatibility is checked at the selected upstream rather than assumed
      from the model name
- [x] No bump needed: `ai@7` wants `zod@^3.25.76 || ^4.1.8` and the lockfile already resolved
      `3.25.76`. The declared range in `apps/backend` and `packages/shared` was raised to `^3.25.76`
      anyway, so a fresh install cannot resolve below the floor — a one-line change, not a migration
- [x] `apps/backend/package.json`: `ai@7` + `@openrouter/ai-sdk-provider@3`; `@anthropic-ai/sdk` and
      `zod-to-json-schema` both dropped, nothing else used the latter
- [x] `llm/client.ts`: OpenRouter provider instance + the `MODELS` operation→slug registry
- [x] `llm/structuredCall.ts`: `generateObject` in place of the forced tool call. The options shape,
      `StructuredCallError`'s two kinds, the single retry and the abort-before-retry rule all
      survived unchanged; `toolName`/`toolDescription` became `schemaName`/`schemaDescription` at the
      call, and stayed the names the errors and logs are keyed on
- [x] Failure classification re-expressed. `TypeValidationError` arrives as the _cause_ of
      `NoObjectGeneratedError` rather than beside it, so the branch reads the cause: a type failure
      is `invalid-input`, anything else (a JSON parse failure, no text at all) is `no-tool-call`.
      A `length` finish stays **non-retryable** and is now visible: the retry would spend a second
      full generation reaching the same ceiling, and `stopReason` in the log is what says to raise
      the limit instead
- [x] `effort` remapped to OpenRouter's `reasoning: { effort }`, which takes the effort value
      directly — no translation table needed after all. `tailorResume` now sends `none`: explicit
      medium effort measured at 22s, and leaving effort absent still allowed similarly expensive
      adaptive reasoning
- [x] Writing routes use Sonnet 5 through OpenRouter, preferring `anthropic` and falling back only to
      `claude-on-aws`, with no other provider eligible
- [x] `require_parameters` protects structured generation and `data_collection: 'deny'` keeps
      candidate data away from providers that may retain it
- [x] `outputTokenLimit` re-derived from measurement. Across 3/5/10-bullet profiles, reasoning was
      1.3k–2.3k tokens while content was 179–330; reasoning is now disabled and the limit again scales
      only with the compact object
- [x] All five repointed — to `MockLanguageModelV4`; `ai@7` ships v3 and v4 mocks and the OpenRouter
      provider implements spec v4. They share a new `llm/fakeModel.ts` (the `fakeChrome.ts` mould),
      because the provider contract is not guessable: token counts are grouped rather than flat and
      a finish reason is an object, so a plausible hand-rolled response reads as a generation that
      used no tokens and stopped for no reason
- [x] `.env.example`, root `README.md` and `apps/backend/README.md`: the key is `OPENROUTER_API_KEY`
      now. The `app.ts` CORS comment never named a vendor, so there was nothing there to change
- [x] One live call per schema, all four green; latency, cost, cached-token counts and the two
      failures they exposed recorded in `apps/backend/README.md`. Implicit caching confirmed working
      on `answerQuestions` (665 of ~868 input tokens read from cache per call)
- [x] **Models** and **Structured output** rewritten under _Key decisions_, plus a new entry for
      implicit caching, since prompt order is load-bearing in `answerQuestions`
- Build test-first, same as the rest

### Multi-tenant authentication (proposed, not started)

Turn djobi from a single-user local tool into something more than one person can sign into. Decisions
and the phase-by-phase plan are in `docs/multi-tenant-auth.md`; the shape of it:

- **Ownership in the data model comes first, with auth second.** Nothing in the database has an owner
  today — `profiles` is a hardcoded singleton and `applications` has no owner column — so the large
  mechanical change is adding one everywhere and scoping every query. Done while there is still
  exactly one tenant, that work is reviewable and a mistake cannot leak anything.
- **The mechanism is an OAuth-first auth library self-hosted against the existing Postgres**, so
  ownership stays a foreign key rather than a claim in someone else's token. MV3 can't hold a client
  secret, so the extension authenticates through `chrome.identity.launchWebAuthFlow` with PKCE.
- **The Duplicate Guard indexes must become user-scoped, and that is a correctness rule.** Unscoped,
  one user's saved application stops another user's analysis and tells them they already applied to a
  job they have never seen.
- **One server-side `ANTHROPIC_API_KEY` funds every signup.** Either users bring their own key or
  there are hard per-user quotas. This gates going public and is not a later hardening task.

### Phase 10 — A deep bullet bank, starred bullets, and a per-role cap (proposed, not started)

Let the candidate keep **every** bullet they have ever written for a role — a dozen or fifteen, not
four — and make each resume a selection from that bank rather than the whole of it. Two controls
decide what lands: the candidate **stars** the bullets that must always appear, and a per-role
**cap** bounds how many more the model may add.

Today every bullet on a role lands on every resume. `tailorResume` already permits omission and
already verifies each kept bullet against the Profile (see _Bullet reconciliation by source index_
above), but nothing bounds the count — so the bank cannot grow without the resume growing with it,
and that is what pushes a resume off one page: `renderResume.tsx` walks a density ladder to fit, and
when the tightest step still spills it returns two pages, its own comment naming the real fix as a
content problem belonging upstream in `llm/tailorResume.ts`. This is that fix.

Decisions:

- **The cap is a maximum, never a target.** A role with three bullets under a cap of six stays at
  three. Padding to reach a number is fabrication, which the tailoring prompt already forbids — the
  two rules must not be allowed to fight.
- **The cap is enforced in `reconcileResume`, not asked for in the prompt.** A cap the model is
  merely told about is a cap that holds until the run where it doesn't, and the failure is a
  two-page PDF nobody attributes to tailoring. The code already resolves every bullet pointer; the
  cap is a truncation on that same pass.
- **One Profile-level default, overridable per role.** `Profile.maxBulletsPerRole` defaults to
  **6**; a `WorkExperience.maxBullets` of `null` inherits it and a number overrides it. A recent role
  deserves more lines than a job from a decade ago, and a flat number cannot express that — while
  making every role carry its own required number is a fussier form for no gain on the common case.
- **The cap lives on the Profile, not on the run.** A persisted preference applying to every
  application, added as an optional field with a schema default exactly as `screeningAnswers` was, so
  stored profiles keep parsing with no migration. A per-application override in the panel is a
  plausible later addition, deliberately not built here; nothing in this shape blocks it.
- **The bank itself is uncapped.** No `.max()` on `bullets`. Fifteen is guidance the options page
  shows as a count, not a schema rule — a limit in `WorkExperienceSchema` is read back out of
  `profiles.data` jsonb, so it would turn a profile that outgrew it into a row the options page
  cannot render. The consequence is that prompt input grows with the bank, which is what makes the
  two token decisions below load-bearing rather than tidy.
- **Starred bullets are present and verbatim.** `WorkExperience.starredIndices` points into the
  role's own `bullets`. The model may neither drop nor reword a starred bullet; `reconcileResume`
  takes `role.bullets[i]` and ignores any text the model sent for it. A "permanent" bullet the model
  can override is a hint, and a hint is what the prompt already is. Rewriting a starred bullet is the
  **candidate's** job, in the options page, on the source text.
- **Indices, not a second array.** `starredBullets: string[]` alongside `bullets: string[]` would
  make resume order a concatenation rather than something the candidate authored, force
  `baseResumeOf` to stop being a pure projection, and split the model's `sourceIndex` across two
  index spaces. Indices keep one authored list, one index space, and an unchanged output schema. The
  price is that deleting a bullet must remap `starredIndices` — one component's concern, and
  testable.
- **Starring is optional and unbounded.** Zero stars is every profile that exists today and must stay
  valid. There is no ceiling either: stars are the candidate's own instruction, so when
  `starredIndices.length` exceeds `maxBullets` the **starred count wins** and the effective cap is
  `max(maxBullets, starredIndices.length)`. Silently discarding a pinned bullet would break the one
  promise starring makes.
- **Therefore nothing bounds resume length any more, and that is deliberate.** The success criterion
  for this phase is that two-page resumes become rare _unless the candidate starred their way into
  one_. The cap governs the model's discretion; it is not a censor on the candidate's choices. The
  density ladder still degrades gracefully behind it.
- **The model owns ordering; the code owns content and presence.** It returns every kept bullet as an
  ordered source index, supplying `text` only for the ones it may reword. Ordering is real tailoring
  — the strongest bullet for this posting belongs first — and it costs nothing to grant, since a
  starred entry carries an index and no prose. Every starred index must appear exactly once; if not,
  the pointers are malformed and the existing fall-back-to-the-source-role rule applies.
- **Starred bullets still go into the prompt**, marked as already included and excluded from the
  selectable set, so the model spends its remaining slots on something the resume does not already
  say.
- **Rewriting stays on for selected bullets, and "sounds natural, not robotic" is a prompt
  instruction with nothing behind it.** Recorded as **unverified — revisit**: no test can assert it
  and no reviewer sees the text before the PDF renders. A deterministic lint for the usual tells
  ("Spearheaded", invented percentages) was considered and rejected — it fires on bullets the
  candidate wrote themselves. What partially covers this instead is starring: a starred bullet is the
  candidate's own sentence and cannot read as machine-written, because it isn't.
- **Nothing about dropped bullets appears in the panel flow.** At a bank of fifteen and a cap of six,
  dropping is the normal case; a per-role "9 dropped" notice is noise that always says the same thing
  and gets ignored within a week. This reverses the earlier plan to report drops in the review UI.
- **Keyword Coverage gets a fourth verdict, because capping breaks its central claim.**
  `keywordCoverage.ts` reports against the tailored resume and its doc says the remedy for an
  uncovered keyword is always the Profile. Once a run can drop a bullet that evidences a keyword, the
  report says "missing" about something the Profile already has, and the advice is wrong. A verdict
  meaning _evidenced in a bullet this run did not select_ turns that into the loop this phase needs:
  it names the bullet worth starring. Coverage still never feeds back into tailoring — that rule is
  load-bearing and is what keeps the report honest.
- **A manually logged application is not capped and knows nothing about stars.** `baseResumeOf`
  projects the Profile with nothing dropped, because a `source: 'manual'` record documents what the
  candidate actually sent. Capping is a tailoring decision and belongs only on the tailoring path.
- **`tailorResume`'s prompt must be split for caching.** It passes one interleaved `userContent`
  string today and never sets `cachedPrefix`, so the Profile — the stable half — is re-sent at full
  price on every posting, while `answerQuestions` does the split properly and measured 665 of ~868
  input tokens served from cache. With an unbounded bank the stable half is the half that grows.
- **`outputTokenLimit` must scale with the cap, not with the bank.** `bulletCount * 120` scales with
  the source bullets; a capped output is bounded by `roles × cap`. At 5 roles × 15 bullets the
  current formula pins to its 2048 ceiling — the exact condition that produced Phase 11's
  `finishReason: 'length'` truncation — to hold an object about a third that size. Reasoning stays
  `effort: 'none'`.

- [ ] `packages/shared/src/schemas.ts`: `Profile.maxBulletsPerRole` (optional, schema default 6),
      `WorkExperience.maxBullets` (nullable, `null` = inherit) and `WorkExperience.starredIndices`
      (optional, default `[]`, `.refine()`d so every index resolves against `bullets`); all three in
      `EMPTY_PROFILE`. No `.max()` on `bullets`
- [ ] Keep the three new fields out of the _resume_. They ride two paths that hand Profile entries
      straight to a `TailoredResume`: `baseResumeOf` returns `profile.workExperience` as-is, and
      `reconcileResume` spreads the whole profile entry. Neither re-parses, so they would land in
      `applications.tailoredResume` jsonb as stored fields of a resume, where they mean nothing.
      Project both entries explicitly instead of spreading
- [ ] `apps/backend/src/llm/tailorResume.ts`: prompt states the cap as a maximum, forbids padding,
      instructs selection against `jobInfo.requirements`/`keywords`, marks starred bullets as already
      included and excluded from selection, and asks for ordered indices with `text` only on
      non-starred entries
- [ ] `reconcileResume`: substitute `role.bullets[i]` verbatim for every starred index, require each
      to appear exactly once, truncate to `max(maxBullets ?? maxBulletsPerRole, starredIndices.length)`,
      and keep returning plain `string[]`
- [ ] `tailorResume`: move instructions + Profile into `cachedPrefix` and leave `<job_info>` in the
      varying tail, matching `answerQuestions`; confirm cache reads in the structured-call metrics
- [ ] `outputTokenLimit`: re-derive from the effective cap; re-measure on a 15-bullet-per-role
      profile before this ships
- [ ] `packages/shared/src/keywordCoverage.ts`: fourth `CoverageVerdict` for a keyword evidenced only
      in an unselected bullet, plus the branch in `panel/CoverageReport.tsx` that says _star it_
      rather than _add it to your Profile_
- [ ] Options page: star toggle per bullet, per-role collapse, a bullet count, and the cap controls
      (Profile default plus per-role override). Deleting or inserting a bullet remaps
      `starredIndices` — one helper, its own tests. No drag-reordering: authored order stopped being
      resume order once the model took ordering
- [ ] Confirm the two-page case recedes — a fixture that previously spilled should now fit, and one
      with more stars than its cap should still be allowed to spill
- Build test-first, same as the rest

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
