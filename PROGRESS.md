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
**Shipped**; only **Planned** describes work that doesn't exist yet. Suite green at **1692 tests**
(278 shared / 26 http-client / 30 profile-editor / 326 backend / 746 extension / 286 dashboard),
`pnpm test` from the repo root. A green run prints nothing: every
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
  their Stage and Notes against the live backend. A marketing `LandingPage` at the bare path, and
  six views behind a hand-rolled hash router (`lib/useHashRoute.ts`): the applications list, one
  application's detail, Analytics, the Profile editor, sign-in and sign-up — with manual logging
  (`NewApplication`) opening inside the list rather than claiming a route of its own. One
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
  report. A keyword found only in a Profile bullet absent from this resume points to that bullet as
  worth starring; a true gap still points to the Profile and may be added only if the candidate has
  it. It is rendered as a gap list rather than a score, because a number on screen is a number
  someone will raise, and the only way to raise this one dishonestly is keyword stuffing. The "ATS rejects below an X%
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
- **Application tracking is `stage` alone** (applied → phone_screen → onsite → offer → rejected).
  There was also a `status` field (draft/submitted) for "did this actually go out"; it was dropped
  in migration `0002` because nothing ever set `submitted` and the field was `draft` on all 28
  rows. The current Save Step does not establish whether employer submission happened. Notes are a
  timestamped, categorized log (`technical` / `behavioral` / `general`) you append to, not a single
  overwritable text field — so old interview-question notes stay around as reference for future
  applications. A note can be **deleted** (`DELETE /applications/:id/notes/:noteId`, two clicks
  behind a confirmation) but never edited: removing an entry the candidate says never belonged is a
  different act from rewriting one in place, which would leave history that cannot be trusted. That
  is not a softening of the append-only rule — see the `addApplicationNote` entry under
  _Constraints that look like mistakes_ — which is about two concurrent writes not silently
  discarding one another, and which `deleteApplicationNote` observes in the same way: one statement,
  `jsonb_agg` over the survivors, never a read-modify-write.
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
  from the request body. **`deleteApplicationNote` follows the same rule from the other side**: one
  statement rebuilding the array with `jsonb_agg` over the notes that survive the filter, so a note
  appended between a read and a write cannot come back from the dead. Its `WHERE` carries an
  `exists` over the array specifically so "deleted" and "there was no such note" stay
  distinguishable — without it the update matches, changes nothing, and `RETURNING` reports success
  for a delete that deleted nothing.
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
uses a capped authored-order fallback. Every starred pointer must appear exactly once and its source
text is copied verbatim; remaining valid model selections keep model order until the effective role
cap is reached. The effective cap is the greater of the configured cap and the star count, so a
candidate's pinned content is never silently discarded.

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

### Phase 20 — Upload resume to populate a Profile (built; two items still open — see below)

Today the Profile is entered by hand in both the options page and the dashboard's `#/profile`. This
phase adds an "Upload resume" action to both that parses an uploaded PDF and pre-fills a draft the
candidate reviews and edits before it's saved — never an auto-save, never a silent overwrite.

- **PDF only, v1.** DOCX is common too but adds a new dependency (`mammoth` or similar) for no
  proven need yet; `unpdf` is already a backend dependency, reused here to extract text from the
  uploaded PDF. Its only current use (`pdf/preflightResume.ts`) is verifying the app's own
  well-formed, self-generated PDFs via flat-text `mergePages: true` extraction — it has never had to
  cope with an arbitrary real-world resume's layout (columns, tables, scanned/image-based pages), so
  extraction quality here is unproven, not a solved problem the plan can assume; budget time to
  eyeball extraction against a handful of real resumes before trusting it. 5MB upload cap, rejected
  with a clear error above that — Hono's multipart parser has no built-in size limit, so this needs
  an explicit byte-length check before/during parsing, and that rejection should go through the same
  `RequestValidationError` → 400 convention `requestBody.ts` already gives every JSON route.
- **Extraction reuses the existing structured-LLM-call seam**, not a new pattern: extracted PDF text
  goes through `llm/structuredCall.ts` (same seam as `extractJob`/`tailorResume`/`answerQuestions`/
  `answerChat`) against a new zod schema for the extractable subset of a Profile, and the object is
  re-validated against that schema before it's returned — same guarantee `structuredCall.ts` already
  gives every other route. Like `extractJob`, the extracted PDF text is untrusted, attacker-authored
  input and must go through `sanitizeXmlContent()` before it reaches the model — the same
  prompt-injection guard `extractJob.ts` already applies, not a new concern this route invents.
- **Three new `Profile` fields, since a resume routinely carries content the schema has no home for
  today:** `summary: string | null` (freeform intro paragraph); `projects:
{name, description, bullets: string[], link: string | null, technologies: string[] | null}[]`
  (mirrors `workExperience`'s bullets shape); `certifications: {name, issuer, date}[]` and
  `awards: {name, issuer, date, description?}[]` as two separate arrays, not one combined list — a
  certification and an award carry different fields (an expiry vs. a description) even though
  resumes often bullet them under one heading. Needs `EMPTY_PROFILE` defaults and a
  `normalizeProfileDraft` update, the same as any new Profile field. **No DB migration**: the
  `profiles` table stores the whole `Profile` as one `jsonb('data')` column
  (`apps/backend/src/db/schema.ts`), so new fields land there automatically, same as every other
  Profile field — do not add columns for these.
- **Extraction populates `fullName`, `email`, `phone`, `location`, `links`, `workExperience`,
  `education`, `skills`, `summary`, `projects`, `certifications`, `awards` — and nothing else.**
  `stories` (STAR-format), `screeningAnswers` and `customAnswers` stay manual-only; no resume
  contains that content, so leaving them out of the extraction schema is not a gap, it's the
  boundary of what a resume can honestly supply.
- **Review-before-save, not merge-on-upload.** A resume is often stale or wrong on specifics (an old
  phone number, a rounded date), and the candidate may already have hand-entered data worth keeping.
  The endpoint returns a draft only; the candidate sees it in a review screen and edits it like any
  other profile field before the existing `POST /profile` save path runs. No new save path, no
  automatic merge/overwrite logic to get subtly wrong.
- **The uploaded file itself is never persisted.** No file storage exists anywhere in this codebase
  today (no S3, no multer/busboy, no `apps/*` upload route) — this phase doesn't introduce any. The
  PDF is parsed in-memory on the backend for one extraction call and discarded.
- **New backend endpoint, `POST /profile/extract-resume`** (multipart, via Hono's built-in
  `c.req.parseBody()`): extract text → structured LLM call → return the draft. Deliberately does not
  call `ProfileStore.save` — extraction and saving stay two separate concerns, the same separation
  Save Step already keeps from Fill Step in the extension pipeline.
- **Entry point added to both editors, not one.** `apps/dashboard/src/views/Profile.tsx` (848 lines)
  already independently re-implements the same `Profile`-editing surface
  `apps/extension/src/options/App.tsx` (933 lines) does (sharing `normalizeProfileDraft`/schema logic
  via `packages/shared`, but its own markup — no `packages/ui` exists). The review-screen markup is
  duplicated in both apps rather than factoring out a new shared UI package now, matching that
  existing pattern; introducing shared UI is a bigger refactor than this feature justifies. That said,
  4 new sections plus a full review screen in both files pushes each past 1000 lines — close enough
  to the threshold where a shared-UI extraction would pay for itself that this is a call worth
  confirming rather than assuming; flag it before starting the UI work if either file is getting
  unwieldy.
- **New sections in both editors, in resume reading order:** `summary` near the top (just after
  contact/links), `projects` and `certifications`/`awards` after `education`.
- **Extraction failure is not a dead end.** A PDF with no extractable text (scanned/image-based,
  corrupt) surfaces an error and the candidate falls back to manual entry. A partial extraction still
  opens the review screen with whatever fields were found; anything the model couldn't confidently
  extract is left blank rather than guessed — same non-fabrication discipline every other LLM route in
  this codebase already holds to.

Chunks below are ordered by dependency; each is independently testable and, except where noted,
independently shippable. TDD per this project's process (`mattpocock-skills:tdd`) within each chunk.

**20.1 — Shared schema & contracts** (foundation; no behavior yet, just types both sides compile against)

- [x] `packages/shared/src/schemas.ts`: `summary`, `projects`, `certifications`, `awards` on
      `ProfileSchema` + `EMPTY_PROFILE` defaults; new extraction-result schema (the extractable
      subset — see above). No DB migration — `profiles.data` is jsonb, see above.
- [x] `packages/shared/src/profileDraft.ts`: `normalizeProfileDraft` updated for the new fields
- [x] `packages/shared/src/wire.ts`: `ExtractResumeResponseSchema`, the response half of the
      paired-contract pattern `extractJob`/`tailorResume`/`answerQuestions` already use — no request
      schema, since the body is a multipart file upload rather than JSON zod can validate the same
      way; the field-name/size-cap/content-type checks stay in the route itself (20.3)
- [x] Tests: schema validation (`ProjectSchema`, `CertificationSchema`, `AwardSchema`, `ProfileSchema`,
      `ExtractedProfileSchema`, `ExtractResumeResponseSchema`) + `normalizeProfileDraft` unit tests for
      the new fields
- [x] Ripple fixed across the workspace: every hand-written `Profile` object literal (dashboard
      fixtures, extension test fixtures, one backend route test) needed the four new fields —
      `tsc --noEmit` catches this in extension/dashboard (whose tsconfig includes test files) but
      **not** in `apps/backend`, whose tsconfig excludes `*.test.ts`; the backend's own
      `routes/profile.test.ts` only surfaced the gap at `vitest run` time. Suite green at **1510
      tests** (261 shared / 21 http-client / 293 backend / 702 extension / 233 dashboard);
      `typecheck`, `build` and `format:check` all clean

**20.2 — Backend extraction logic** (depends on 20.1; pure function, no route/HTTP surface yet)

- [x] `apps/backend/src/llm/extractResume.ts` (new): PDF text via `unpdf` (same call
      `pdf/preflightResume.ts` makes) + `sanitizeXmlContent` + structured call against
      `ExtractedProfileSchema`, routed as its own `extractResume` operation in `llm/routing.ts` (same
      cheap `google/gemini-3.1-flash-lite` tier as `extractJob`, wider 4096-token budget — a resume
      routinely reports several roles plus projects/certifications/awards in one response). A PDF
      that fails to parse, or yields only whitespace, throws `NoResumeTextError` rather than an
      unrelated 500 — deliberately the same outcome for "scanned/image PDF" and "not really a PDF at
      all," since both have the same remedy (fall back to manual entry)
- [x] Tests: fixture text in (mocked `unpdf` + `structuredCall`, same fake-provider seam
      `extractJob.test.ts` uses) → structured object out; sanitization-before-model, no-extractable-
      text, unparseable-PDF, and partial-extraction cases
- [ ] **Not done — live check still open:** extraction has not been run against a handful of real,
      differently-laid-out resumes (columns, tables) with a live `OPENROUTER_API_KEY`. The plan's
      earlier note that `unpdf` is unproven on arbitrary layouts is still just that — unproven — and
      this is the step that was supposed to close it before the chunk is trusted

**20.3 — Backend route** (depends on 20.1, 20.2; independently shippable once done — testable via curl/Postman even before any UI exists)

- [x] `apps/backend/src/routes/profile.ts`: `POST /profile/extract-resume` (multipart via
      `c.req.parseBody()`, `content-length` pre-check plus a `File.size` backstop against the
      5MB cap, PDF-only content-type check, draft-only — never calls `ProfileStore.save`). A rejected
      upload (missing field, wrong content-type, oversized, unreadable PDF) is a `RequestValidationError`
      the same way every JSON route's body rejection is
- [x] **Found during this chunk, not in the original plan: `app.ts`'s CSRF content-type guard had to
      widen.** That guard requires `content-type: application/json` on every state-changing request
      specifically because `application/json` forces a CORS preflight the origin allowlist can
      refuse — but `multipart/form-data` (what a file upload sends) is itself one of the three CORS
      "simple" content types, so accepting it here with no further check would have quietly reopened
      that exact hole for this one route: an unrelated page could trigger a real (billed) extraction
      call using the dashboard's session cookie, unable to read the response but not needing to.
      Fixed by requiring a non-simple `x-djobi-upload` header (added to the CORS `allowHeaders`
      list) on any multipart request, which forces the same preflight `application/json` gets for
      free. `@djobi/http-client`'s new `upload()` transport method (below) attaches it automatically,
      so no call site can forget it. Covered in `cors.test.ts` and `routes/profile.test.ts`
- [x] Tests: happy path, missing file field, non-PDF content-type, oversized upload (both the
      `content-length` and `File.size` paths — a real multipart body makes both fire together, so
      that's one case, not two), no-extractable-text PDF, auth required, and the multipart CSRF guard
      itself (`cors.test.ts`)
- [ ] **Still open, not a code task:** the decision on whether the pre-existing absence of
      rate/spend limiting on LLM routes needs addressing for this specifically higher-cost route
      (`rateLimit` in `auth.ts` only covers sign-in/sign-up today) — unchanged from the original plan,
      not resolved by the CSRF fix above, which stops a _forged_ request but does nothing about a
      signed-in candidate uploading repeatedly
- [x] `@djobi/http-client`: new `HttpTransport.upload()` — sends a `FormData` body untouched (never
      `JSON.stringify`'d), decodes the JSON response through the caller's schema via the same
      `decodeJson` helper `json()` now shares, and attaches `x-djobi-upload` (see above). `callBackend.ts`
      wraps it as `callBackendUpload`; `backendClient.ts`'s `extractResume` is its only caller

**20.4 — Extension options UI** (depends on 20.1–20.3; independent of 20.5, can run in parallel with it)

- [x] `apps/extension/src/options/App.tsx`: an "Upload resume" section (file input, PDF only) calls
      `client.extractResume`, then applies whatever it found straight into the live form via a new
      shared `applyExtractedProfile` (`packages/shared/src/profileDraft.ts`) — field by field, never a
      blanket replace: a field the extraction found overwrites the draft, a field it left null/empty
      (including every array field) leaves the draft exactly as it was, so a resume with no phone
      number on it can never blank one the candidate already typed. Not saved: `setProfile` marks the
      form `dirty` the same as any manual edit, and the existing Save button is still the only write
      path. New `summary` section (after Links), `projects`/`certifications`/`awards` sections (after
      Education) — resume reading order, per the plan
- [x] **Deliberate scope cut from the original plan: no separate review screen.** The plan called for
      "a review screen" distinct from the main form; this reuses the main form itself as the review
      surface instead — the extraction pre-fills the same editable fields the candidate can already
      correct, and nothing saves until they click Save profile, which satisfies "review before save"
      without a second, largely-duplicate set of inputs. This also pre-empts the plan's own flagged
      risk ("a full review screen in both files pushes each past 1000 lines") rather than hitting it.
      `apps/dashboard/src/views/Profile.tsx` (20.5) does not have to make the same call, since its
      form is a separate implementation — worth deciding explicitly there rather than assuming this
      choice carries over
- [x] Tests (`App.test.tsx`): upload → pre-filled form → edit → save; a field the candidate already
      filled in survives an extraction that found nothing for it; extraction failure shows a clear
      error and leaves the form untouched (manual-entry fallback); a 401 on the upload itself routes
      to the sign-in view like any other route
- [x] `backendClient.ts`: `BackendClient.extractResume(file, signal?)`, the `httpBackendClient`
      adapter (`callBackendUpload`, field name `resume`), and the fake client's default extraction —
      plus `applicationPipeline.test.ts`'s hand-rolled `BackendClient` fixture, which needed the new
      method to keep satisfying the widened interface (the same ripple every earlier `BackendClient`
      addition has caused)

**20.5 — Dashboard UI** (depends on 20.1–20.3; independent of 20.4, can run in parallel with it)

- [x] `apps/dashboard/src/views/Profile.tsx`: same, independently implemented — an Upload section,
      `summary`/`projects`/`certifications`/`awards` panels (resume reading order), reusing the same
      `applyExtractedProfile` (`@djobi/shared`) 20.4 introduced rather than a second copy of the
      merge rule; the markup itself is its own implementation, per the existing pattern this file's
      own header comment states (shared draft-normalization logic, dashboard-specific chrome). Same
      "no separate review screen" call as 20.4, made independently here rather than assumed inherited
- [x] `dashboardClient.ts`: `DashboardClient.extractResume(file)`, the `httpDashboardClient` adapter
      (`transport.upload`, field name `resume`), and `createFixtureDashboardClient`'s new
      `FixtureResumeUploadOptions` fourth parameter (`extraction`/`error`, mirroring
      `FixtureAuthOptions`'s config-bag shape) — plus a new `fixtureExtractedProfile` in `fixtures.ts`
      and the two hand-rolled `DashboardClient` fixtures (`useApplicationStore.test.ts`,
      `application-mutations.test.tsx`) that needed the new method to keep satisfying the interface
- [x] Tests: upload → pre-filled form → edit → save; a field the candidate already filled in
      survives an extraction that found nothing for it; extraction failure shows a clear error and
      leaves the form untouched; a 401 on the upload itself redirects to login like any other route
      (`tests/profile.test.tsx`); `createFixtureDashboardClient`'s new fixture behavior
      (`lib/dashboardClient.test.ts`); the raw multipart request shape (`lib/httpDashboardClient.test.ts`)
- [x] **Found during this chunk: an invalid fixture URL silently blocked form submission with no
      error.** `fixtureExtractedProfile.links.linkedin` was first written as `'linkedin.com/in/…'`
      (no scheme) — HTML5 `<input type="url">` constraint validation rejects that, and a browser
      (jsdom included) silently withholds the `submit` event entirely rather than firing it, with no
      exception and no console output. From the outside this looked exactly like a dead click
      handler; tracing it took directly instrumenting `handleSave` to notice it was never being
      called at all. Fixed by using a real absolute URL in the fixture. Worth remembering for any
      future fixture touching a `type="url"`/`type="email"` field: an invalid value doesn't error,
      it just makes Save silently do nothing
- [x] **Mid-chunk design update (both 20.4 and 20.5), from a design reference the user supplied
      after the rest of this chunk was already built:** the Upload section became a bordered card
      (icon + "Have a resume already?" + a one-line pitch + an "Upload resume" button), copy fixed to
      say PDF only rather than "PDF or Word" (matching the phase's actual PDF-only scope), and the
      icon square is itself a second click target for the same file picker. New shared CSS added to
      both apps' `App.css` (`.upload-resume-card*`, `.visually-hidden` — the real `<input
type="file">` is visually hidden and opened by proxy via a `ref`, not the browser's own file
      picker chrome), token-driven (`--ring`/`--primary`/`--radius-*`) so both apps stay visually one
      product per `App.css`'s own header comment
- [x] File size, checked as the plan asked: both editors are now past 1000 lines
      (`apps/extension/src/options/App.tsx` 1283, `apps/dashboard/src/views/Profile.tsx` 1204).
      Flagging rather than acting on it — a `packages/ui` extraction is a real refactor with its own
      risk, and Phase 20 shipping correctly matters more than pre-emptively restructuring two files
      that still typecheck, build and test cleanly. Worth a dedicated pass before either file grows
      its next section
- [x] Suite green at **1553 tests** (268 shared / 25 http-client / 311 backend / 708 extension / 241
      dashboard); `typecheck`, `build` and `format:check` all clean

**All five chunks (20.1–20.5) are built and tested. Two items from 20.2/20.3 remain open, neither
a code task:**

- [ ] Live: extraction has not been run against real, differently-laid-out resumes with a live
      `OPENROUTER_API_KEY` — the plan's earlier note that `unpdf` is unproven on arbitrary layouts
      is still unproven, not solved. Same shape as Phase 19's own still-open `eval:extraction` item
- [ ] Decision to close out, not resolved by this phase's own CSRF fix (that closes a forged-request
      hole; it says nothing about a signed-in candidate's own repeated use): whether the pre-existing
      absence of rate/spend limiting on LLM routes needs addressing for this specifically higher-cost
      route (`rateLimit` in `auth.ts` only covers sign-in/sign-up today)

**Post-completion UI changes, both apps, from user feedback after the above landed:**

- **Certifications and Awards became one section, not two**, in both `apps/extension/src/options/App.tsx`
  and `apps/dashboard/src/views/Profile.tsx`. The schema stayed exactly as designed — two separate
  arrays, since a certification has no description and an award has no expiry — only the editing
  surface changed: one combined list (`credentialItems`, a flat per-row `CredentialItem` — not a
  discriminated union of `Certification`/`Award`, since `Partial` of a union keeps only the keys
  every member shares and `description` would silently become unpatchable) with a "Type" picker per
  row that moves the row between the two arrays on change (`changeCredentialKind`), carrying
  `name`/`issuer`/`date` across and dropping/gaining `description`. A row reappears at the end of
  its new array on a kind switch — there's no shared ordering field between the two arrays to
  preserve a position across. One real bug caught before it shipped: the naive version issued two
  separate `setProfile` calls (remove-then-add) for a kind switch, and the second silently undid the
  first — both closed over the same pre-update `profile`, so the second call's `...profile` spread
  never saw the first's change. Fixed to one atomic `setProfile` call per switch.
- **The Upload section's copy and shape changed twice, both from a design reference the user
  supplied:** first became a card (icon + "Have a resume already?" + a one-line pitch + an "Upload
  resume" button), copy fixed to say PDF only rather than "PDF or Word"; then the button was dropped
  entirely and the icon alone (already a second click target from the first pass) became the sole
  upload trigger — `aria-label` on the icon button switches between "Upload resume" and "Parsing
  resume…", and the pitch line itself switches to "Parsing…" while a call is in flight, so removing
  the text button didn't remove the only in-progress feedback.
- Suite green at **1561 tests** (268 shared / 25 http-client / 311 backend / 712 extension / 245
  dashboard); `typecheck`, `build` and `format:check` all clean.

### Phase 19 — Provenance persistence + a real-posting eval corpus (done)

The last of the seven audit improvements (item 7) plus the audit's closing recommended step: store
what an Application's matching actually rested on, and give extraction/matching prompt changes
something real to be judged against. Directly closes the gap "Known loose ends" has named since
Phase 12: `applications` never stored the posting text, so no extraction improvement could ever be
backfilled or even checked against what it ran on.

- **Four new nullable `Application` fields**, `packages/shared/src/schemas.ts`: `rawDescription`
  (the posting text `extractJob` analyzed), `extractionVersion` (see below), `requirementEvidence`
  (`RequirementEvidence[]`, Phase 14's matcher), `bulletProvenance` (`BulletProvenanceEntry[]`, new —
  see below). All four `.nullable()` with no default on `ApplicationSchema` (every row read back
  post-migration has the column, `NULL` for one written before it existed) and `.nullable().default(...)`
  on `NewApplicationSchema` (a caller may omit any of them and get an honest default rather than a
  400).
- **`EXTRACTION_VERSION` is a schema default, not a value any caller sets.** A plain exported
  constant (`packages/shared/src/schemas.ts`), stamped automatically by
  `NewApplicationSchema.extractionVersion`'s `.default(EXTRACTION_VERSION)` — so every write from
  today's code is tagged correctly with zero call-site changes, the same reasoning `stage`/`notes`
  default rather than requiring every existing poster to state them. It is a compatibility marker
  for the shape `JobInfoSchema`/`TailoredResumeSchema` produce today, bumped only on a materially
  widening change (Phase 12/13-style), not on every prompt wording tweak.
- **`bulletProvenance.ts` (new shared module) generalizes `panel/ResumeReview.tsx`'s bullet-pairing
  logic**, which moved here from the extension (was `matchBulletSource.ts`) so the backend-agnostic
  audit trail and the panel's live "Originally: …" line are one implementation, not two that can
  drift. Adds `bulletProvenance(resume, profile)`, the whole-resume aggregate `matchBulletSource`
  didn't have: every bullet, paired to its role, with the same verbatim/reworded/unmatched verdict
  `ResumeReview.tsx` already showed one bullet at a time.
- **Both provenance fields are computed client-side, at save time, not server-side.** `POST
/applications` only ever received an `ApplicationStore`, never a Profile store — widening that
  route to fetch a Profile for a derivation it could do itself was a bigger seam change than the
  alternative: the extension already holds Profile, `jobInfo` and the final `tailoredResume`
  together at the moment it calls Save, so `background/applicationPipeline.ts`'s `runSaveApplication`
  and `panel/LogApplication.tsx`'s `handleSave` each call `requirementEvidence`/`bulletProvenance`
  directly and attach the result. The backend stores what it's given, the same trust boundary
  `jobInfo`/`tailoredResume` themselves already cross on this route.
- **The Profile is fetched fresh at save time, not threaded from Analysis.** `runSaveApplication`
  didn't have a Profile in scope before this phase (Fill does, Save didn't) — rather than widen the
  `UPDATE_RUN`/`START_SAVE_APPLICATION` message contract to carry one, it calls
  `deps.backend.getProfile()` itself. Deliberately not load-bearing: `.catch(() => null)` means a
  Profile that can't be read at save time (deleted, or the backend briefly unreachable) puts `null`
  in both provenance fields rather than failing a write the candidate is actively waiting on — and
  arguably more correct anyway, since a save should be judged against the Profile that exists _now_,
  not the one tailoring ran against minutes earlier.
- **Both provenance fields are a snapshot, computed once, never recomputed.** A later Profile edit
  does not change what a past Application says it evidenced — the same reasoning `stage`/`notes`
  already keep untouched by a re-save (`ApplicationSnapshotSchema` still omits those two, but _does_
  let a re-save recompute-and-resend `rawDescription`/`requirementEvidence`/`bulletProvenance`, since
  those describe the reviewed snapshot itself rather than its tracking metadata).
- **`RequirementEvidenceSchema`/`BulletProvenanceEntrySchema` live in `schemas.ts`, structurally
  matching rather than being inferred from `requirementEvidence.ts`/`bulletProvenance.ts`'s own
  types.** Those two modules import `JobRequirement`/`Profile`/`TailoredResume` _from_ `schemas.ts`
  already; importing a schema back the other way would be a genuine runtime circular import between
  two modules that both declare zod values, not just types. Each pair of type names would otherwise
  collide on re-export from the package root, so `schemas.ts` deliberately exports only the
  validators (`RequirementEvidenceSchema`, `BulletProvenanceEntrySchema`) and leaves the TS type
  names (`RequirementEvidenceVerdict`, `BulletProvenanceEntry`, …) to their original modules as the
  source of truth.
- **The eval corpus is a hand-run script, not a test.** `apps/backend/scripts/evalExtraction.ts`
  runs the real `extractJob` + `tailorResume` (live model calls, real cost, non-deterministic) against
  three hand-written realistic postings and one sample Profile, then prints
  `requirementEvidence`/`bulletProvenance` for each — the same checks a save now persists — so a
  prompt change can be judged against real output before it ships. Deliberately not CI: cost and
  nondeterminism make it a developer tool (`pnpm --filter backend eval:extraction`), not a gate.
  `scripts/tsconfig.json` exists purely so the script (outside `src/`, outside the main `tsconfig`'s
  `rootDir`) can still be typechecked by hand; it is not wired into `pnpm typecheck`, matching how
  backend test files already sit outside that pass.

- [x] `packages/shared/src/schemas.ts`: `EXTRACTION_VERSION`, `RequirementEvidenceVerdictSchema`,
      `RequirementEvidenceSchema`, `BulletProvenanceVerdictSchema`, `BulletProvenanceEntrySchema`,
      and the four new `Application`/`NewApplicationSchema` fields
- [x] `packages/shared/src/bulletProvenance.ts` (new, replacing `apps/extension/src/panel/matchBulletSource.ts`) + `index.ts` export; `ResumeReview.tsx` re-pointed at the shared module
- [x] `apps/backend/src/db/schema.ts` + migration `0008_numerous_doorman.sql`: `raw_description`,
      `extraction_version`, `requirement_evidence`, `bullet_provenance`, all nullable jsonb/text.
      Generated via `drizzle-kit generate`, which needed no live database connection
- [x] `apps/backend/src/db/database.integration.test.ts` and `applicationStore.contract.test.ts`:
      hand-written `CREATE TABLE applications` DDL (these don't run the real migrations) updated to
      match — both left the new columns out of their seeded `INSERT`s on purpose, modeling rows
      written before this phase
- [x] `apps/extension/src/background/applicationPipeline.ts`: `runSaveApplication` fetches the
      Profile, computes both provenance fields, attaches `rawDescription`/`extractionVersion`
- [x] `apps/extension/src/panel/LogApplication.tsx`: same computation on the manual/Log path, against
      `baseResumeOf(profile)` since nothing was tailored
- [x] `apps/backend/scripts/evalExtraction.ts` (new) + `eval:extraction` package script
- [x] Suite green at 1374 tests (235 shared / 16 http-client / 256 backend / 689 extension / 178
      dashboard) — extension's count reflects `matchBulletSource.test.ts`'s 5 cases moving to
      `packages/shared/src/bulletProvenance.test.ts` net of new integration coverage;
      `typecheck`, `build` and `format:check` all clean
- [ ] Live: `eval:extraction` has not actually been run against a live `OPENROUTER_API_KEY` yet — the
      script is written and typechecks, but nobody has eyeballed its output for a real model
- [ ] Not done: no dashboard UI surfaces any of the four new fields yet. This phase is persistence
      only — "for audits and regression testing" per the audit item's own wording, which the eval
      script and `getPipelineRun`-style manual inspection satisfy without a UI. A detail-page panel
      showing `rawDescription`/the evidence report is a plausible later addition, deliberately not
      built here

### Phases 16–17 — Bullet truthfulness, review/edit, role ordering and suppression (done)

Two more of the seven audit improvements: verifiably truthful bullet rewriting with a review surface
(item 3, partially — see _Known loose ends_ below for what's still open), resume editing (item 4),
and conventional experience ordering plus opt-in suppression (item 5). Built concurrently with
another in-progress phase (PDF preflight / Unicode fonts / Letter-A4 / `Role:` prefix) touching
`schemas.ts`, `renderResume.tsx` and `options/App.tsx` in parallel — every file this phase shares
with that work was re-read immediately before editing, and the two landed without conflict.

**Phase 16a — `apps/backend/src/llm/bulletTruthfulness.ts`.** `reconcileResume` already guarantees a
kept bullet traces to a real source pointer; it never guaranteed the _rewrite's own wording_ stayed
truthful. New deterministic check, wired into `bulletsFor`: a rewrite's numbers (`\d[\d,.]*(%|x|\+)?`)
and proper-noun-like terms (capitalized words that aren't the first word of their sentence — a cheap
proxy for a named technology, product, or metric label) must already appear somewhere in the source
bullet it rewrote; if not, the rewrite reverts to the source **verbatim**, never to a rejection or a
second model call. Numbers are matched by substring, not `containsAsWords`' word-boundary rule — a
number is routinely glued to a unit (`400ms`, `1.8s`) with no non-alphanumeric character for a
word-boundary check to anchor on, which would false-flag every truthful number-plus-unit rewrite as
invented. A starred bullet is exempt (it's already the candidate's own sentence, never rewritten).

**Phase 16b — `apps/extension/src/panel/ResumeReview.tsx`.** Lets the candidate edit, reorder or
remove any tailored bullet before Fill runs, and shows a best-effort "Originally: …" line with a
one-click revert for a bullet that was reworded from a Profile sentence.

- **Source pairing is a best-effort _reading_, not a trace.** `sourceIndex` pointers exist only
  inside `tailorResume.ts` and never reach the wire (`TailoredResume` is plain strings), so
  `matchBulletSource.ts` pairs a tailored bullet back to its likely Profile source by exact match
  first, then highest word overlap among that role's Profile bullets — the same
  `containsAsWords`/word-overlap primitive `requirementEvidence.ts` uses, at a smaller grain. A
  bullet the candidate typed from scratch here shows no "Originally" line; that is an honest gap in
  what this surface can claim, not a bug.
- **Roles are paired by company + title + startDate, not array index.** `suppressIfEmpty` (Phase
  17 below) can drop a role from the tailored resume entirely, which would shift every later index
  out of alignment with `profile.workExperience` if index were used.
- **The run's `tailoredResume` becomes a third candidate-editable field, alongside `answers` and
  `jobDescription`.** `useActiveRun.updateTailoredResume` mirrors `updateAnswer` exactly — refused
  for a run this panel is no longer showing, and a `saved` run reverts to `filled` since the record
  on file no longer matches what was reviewed. This crosses a line `usePipelineRun.ts`'s own
  docstring calls out as deliberate ("ownership is deliberately lopsided" — the background owns
  Analysis output, this hook owns typed candidate edits): `tailoredResume` starts as Analysis
  output but becomes candidate-owned the moment a review edit touches it, the same way a drafted
  `QuestionAnswer` already does.
- **The optimistic-echo reconciliation (`editsOf`, the pending-edit dedup) had to widen with it, not
  just the type.** `editsOf` now includes `tailoredResume`, and `edit()`'s own-edit signature is
  computed from the _merged_ local state (`editsOf(merged)`) rather than from the raw `edits`
  argument — serializing `edits` directly would drop `tailoredResume` from an answers-only edit's
  signature, and the echo for the _next_ resume edit would then never be recognized as this hook's
  own, leaving it "pending" forever. Caught by re-running `usePipelineRun.test.ts` before trusting
  the change, not by inspection.
- **`updates.tailoredResume` is optional on the wire (`UpdateRunMessageSchema`), never sent as
  `undefined`.** An answers-only edit omits the key entirely, which is what lets
  `patchPipelineRun`'s partial-merge (`{...state.run, ...patch}`) leave the stored resume alone.
- **No new pipeline status or hard approval gate.** The audit item asked to "require approval… before
  automatically attaching" — this app has no auto-attach step to begin with; Fill was already an
  explicit, reviewed click. Adding a blocking gate specific to the resume would have meant extending
  `reviewOf`/`canReview`/`FILLABLE_FROM` (see _Constraints that look like mistakes_ above) under a
  deadline, which is exactly the kind of change that file's own history says to get right or not do.
  Recorded as a real, deliberate scope cut — see _Known loose ends_.
- **The open PDF preview is cleared, not refreshed, on a review edit.** `useResumePreview` renders
  on demand only; clearing it drops back to the "Preview tailored resume" button rather than leaving
  a blob on screen that no longer matches what Fill will write. Same reasoning `handleAnalyze`
  already applies to a stale preview.

**Phase 17 — role order and suppression, `packages/shared/src/schemas.ts` +
`apps/backend/src/llm/tailorResume.ts`.**

- **Bug fix, not just an addition: `reconcileResume` let the model reorder roles.** A `sourceIndex`
  was read as controlling both _which_ role's bullets to use and _where_ that role sat in the
  output — `safeModelRoles.length === profile.workExperience.length` (every role present exactly
  once) was sufficient to let the model's own order win. Role order now always equals
  `profile.workExperience`'s order, full stop; a `sourceIndex` only selects which role's bullets a
  model entry describes. This also simplified the function — `safelyReordered` and its branch are
  gone.
- **`WorkExperienceSchema.suppressIfEmpty`** (`.default(false)`, per-role, same shape as
  `maxBullets`/`starredIndices`): when tailoring selects zero bullets for a role, `reconcileResume`
  drops it from the output entirely only if this is explicitly set — never by default, since
  silently hiding a role nobody asked to hide would misrepresent the candidate's own employment
  history. Enforced as a `.filter()` after bullet resolution, not asked of the model: same reasoning
  `maxBullets` capping already uses (see Phase 10) — a rule the model is merely told about is a rule
  that holds until the run where it doesn't.
- **`baseResumeOf` deliberately does not apply suppression.** A manually logged application
  (`source: 'manual'`) documents what the candidate actually sent, with nothing dropped — the same
  "capping is a tailoring decision and belongs only on the tailoring path" reasoning Phase 10
  already established for `maxBullets`.
- **Options-page toggle**: a checkbox per role, "Hide role N entirely if tailoring selects no
  bullets for it", next to the existing "Bullet cap N" field — `apps/extension/src/options/App.tsx`.

- [x] `packages/shared/src/schemas.ts`: `WorkExperienceSchema.suppressIfEmpty`
- [x] `apps/backend/src/llm/bulletTruthfulness.ts` (new) + wired into `tailorResume.ts`'s `bulletsFor`
- [x] `apps/backend/src/llm/tailorResume.ts`: `reconcileResume` role-order fix + suppression filter;
      prompt instructions updated to state role order is fixed, not model-controlled
- [x] `apps/extension/src/panel/matchBulletSource.ts` (new), `ResumeReview.tsx` (new)
- [x] `apps/extension/src/panel/usePipelineRun.ts`, `useActiveRun.ts`, `lib/messages.ts`: the
      `tailoredResume` edit channel described above
- [x] `apps/extension/src/panel/AutofillTab.tsx`: `ResumeReview` slotted into the review screen
      between the PDF preview and `CoverageReport`; preview cleared on a review edit
- [x] `apps/extension/src/options/App.tsx`: `suppressIfEmpty` checkbox + blank-role-template default
- [x] Suite green at 1365 tests (222 shared / 16 http-client / 256 backend / 693 extension / 178
      dashboard); `typecheck`, `build` and `format:check` all clean. Ripple from the new default
      field resolved via the type-checker: `apps/dashboard/src/lib/fixtures.ts`,
      `apps/backend/src/llm/tailorResume.test.ts`, and every extension test fixturing a
      `WorkExperience` (`options/App.test.tsx`, `profileDraft.test.ts`, `LogApplication.test.tsx`)
- [x] `apps/extension/src/panel/AutofillTab.test.tsx`: one full round-trip test (message ->
      `background/router.ts` -> `applicationPipeline` -> `tabStore` -> `chrome.storage.onChanged` ->
      hook -> render -> edit -> checkpoint), not just the isolated `ResumeReview` unit tests, since
      the risk in this phase was the plumbing between them
- [ ] Live: no live model call exercises `bulletTruthfulness.ts` against real rewrites yet — the
      fake-model suite covers the logic, not whether real Sonnet 5 output trips the false-positive
      rate up (a legitimate rewrite that happens to introduce a number/proper noun already implied,
      but not stated, by the source)

Known loose ends this phase leaves open:

- **No hard "must review before Fill" gate.** The candidate can Fill without ever opening "Review
  resume bullets" — nothing currently forces the panel open or blocks the button. Scoped out
  deliberately (see above); building it means touching `reviewOf`/`canReview`/`FILLABLE_FROM`, which
  is real surgery on a state machine `PROGRESS.md`'s own _Constraints_ section calls delicate.
- **Source pairing can mislabel or miss.** Word-overlap is a heuristic; a short bullet reworded
  heavily enough can show no "Originally" line, or pair with the wrong role's bullet if two roles
  share very similar phrasing. Nothing here claims more precision than that.
- **No persisted diff/warning trail.** A reverted bullet (Phase 16a) or a candidate's edit (Phase
  16b) leaves no record beyond the current `tailoredResume` value — audit item 7 (persist matching
  provenance) is unstarted, and this phase doesn't touch it.

### Phases 13–15 — Posting-spelling preservation, requirement-to-evidence matching, and evidence-aware tailoring (done)

Three of the seven highest-impact improvements from a codebase audit, in the sequence the audit
recommended: finish extraction, then requirement-level matching (not just keyword-level), then feed
that matching into what `tailorResume` prioritizes. The remaining four (verifiable bullet rewriting
with a source-vs-rewrite diff, resume edit/approval, ordering/suppression, PDF preflight, provenance
persistence) are unstarted — see the audit's original phase list for what's next.

**Phase 13 — `JobKeyword.postingSpelling`.** `extractJob` already canonicalized keyword spelling
(Phase 12); the audit's remaining gap was that the posting's own wording was discarded once
canonicalized. `JobKeywordSchema` gained `postingSpelling: string | null`, `.nullable().default(null)`
so every existing row and every hand-built fixture across the repo keeps parsing/compiling with no
edit required at the call site — the same tolerant-default shape `maxBullets` already established.
The field is read, not just kept: `keywordCoverage.ts` now matches a keyword's `term` **or** its
`postingSpelling` against a Profile — a Profile saying "K8s" is no longer reported `missing` merely
because the posting's canonical echo is "Kubernetes". This is not a synonym table (which
`keywordCoverage.ts`'s own doc comment argues against at length): both spellings come from the same
`extractJob` call about the same posting, so using both is using data already captured, not guessing
at an alias. The report still names the keyword by `term`, since that's the spelling the rest of the
app reads.

**Phase 14 — `packages/shared/src/requirementEvidence.ts`.** `keywordCoverage.ts` answers "does a
keyword string appear"; nothing answered the higher-level question the audit named: does the Profile
actually evidence a stated _requirement_, only as a bare skill with no story behind it, only in the
Profile but dropped from this tailored/capped resume, ambiguously, or not at all. New module, same
discipline as `keywordCoverage.ts` — deterministic, no model call, a report and never a correction,
since `reconcileResume` already forces every kept bullet through the authoritative Profile and this
module cannot add anything to a resume.

- **Five verdicts**, not `keywordCoverage`'s four: `direct-evidence`, `skill-only`,
  `omitted-profile-evidence`, `needs-confirmation`, `unsupported`. `needs-confirmation` is the new
  one keyword-level matching had no room for — a partial word-overlap match, or a years requirement
  whose tenure can't be established either way. Deliberately not collapsed into `unsupported`: an
  ambiguous signal and a genuine absence should not read as identical to the candidate.
- **Word-overlap matching, scoped to this module.** A small local stopword list and a
  `containsAsWords`-based hit ratio (reused from `labelMatching.ts`) score a requirement's content
  words against resume bullets, skills, and Profile-only bullets in that order; `≥60%` overlap is
  `direct-evidence`/`skill-only`/`omitted-profile-evidence`, any lesser overlap is
  `needs-confirmation`, none is `unsupported`. Not `labelMatching.ts`'s own stemmed
  content-word/stopword machinery — that module's docstring frames it as one loop (scraped label ↔
  drafted answer ↔ page), and requirement-vs-resume matching is a different problem with its own
  tuning; the private helpers aren't exported for reuse.
- **`yearsOfExperience` is checked against the Profile's dated roles, summed without deduplicating
  overlap** (two concurrent roles double-count) — a known, documented limitation, not a silent one.
  An unparsable `startDate`/`endDate` **never** resolves to "not enough years"; it resolves to
  `needs-confirmation`, because asserting a years claim from unreadable data is exactly the guess
  `extractJob`'s own prompt already forbids on the model side. Tenure short of the stated number
  still reads `needs-confirmation` (not `unsupported`) when the domain otherwise matches, since the
  undercounting above can only be wrong in the direction of _understating_ true tenure.
- **Only reads `workExperience` and `skills`**, the same restriction `keywordCoverage.ts` accepts —
  neither module's inputs carry education or certifications, so a degree requirement always reads
  `unsupported` even when the candidate has it. A false negative, not a false claim; recorded here
  rather than silently inherited.
- **Required first, preferred second, unspecified last**, stable within each group in posting order —
  the audit's "prioritize required qualifications over preferred ones", answered as a sort rather
  than a scoring formula.

**Phase 15 — wired into `tailorResume`'s prompt.** Before the model call, `tailorResume.ts` now runs
`requirementEvidence(baseResumeOf(grounding), jobInfo, grounding)` — against the **full, uncapped**
bullet bank via `baseResumeOf`, not the eventual tailored output, since there is no tailored output
yet and the question worth answering is "can the Profile support this at all". The result is
serialized into a `<requirement_evidence>` block in the varying tail (alongside `<job_info>`, not the
cached prefix — it's job-specific, same reasoning `<job_info>` itself already follows), and the
instructions gain one paragraph: prioritize keeping/selecting the bullets it names as `evidencedBy`
for evidenced required items over preferred-only content, and never invent a bullet for an
`unsupported`/`needs-confirmation` required item. The block is omitted entirely (not emitted empty)
when a posting states no requirements. `baseResumeOf`'s parameter narrowed from `Profile` to
`Pick<Profile, 'skills' | 'workExperience'>` to make this callable against a `TailorResumeProfile`
projection (no `fullName`/`email`/…) without widening what reaches the model.

- [x] `packages/shared/src/schemas.ts`: `JobKeywordSchema.postingSpelling`, tolerant-lift branch
      updated, `baseResumeOf` narrowed to `Pick<Profile, 'skills' | 'workExperience'>`
- [x] `packages/shared/src/keywordCoverage.ts`: matches `term` or `postingSpelling`, doc comment
      revised to state the one exception to "no alias table"
- [x] `apps/backend/src/llm/extractJob.ts`: prompt asks for `postingSpelling` alongside the canonical
      `term`
- [x] `packages/shared/src/requirementEvidence.ts` (new) + `index.ts` export
- [x] `apps/backend/src/llm/tailorResume.ts`: `requirementEvidenceContext`, wired into `userContent`
      and the instructions paragraph
- [x] Ripple from the new default field, resolved via the type-checker rather than grepped by hand:
      `apps/dashboard/src/lib/fixtures.ts` (18 keyword literals), `apps/dashboard/src/views/Analytics.tsx`
      (synthesized `{ keywords: distinct }` — `postingSpelling: null`, documented as a cross-posting
      aggregate with no single posting to attribute it to), test fixtures across
      `apps/backend/src/routes/*.test.ts`, `apps/extension/src/panel/LogApplication.test.tsx`, and
      `apps/dashboard/src/lib/analytics.test.ts`'s `keyword()` helper
- [x] Suite green at 1328 tests (222 shared / 16 http-client / 236 backend / 676 extension / 178
      dashboard); `typecheck`, `build` and `format:check` all clean
- [ ] Live: no live model call made against the new `postingSpelling` prompt instruction or the
      `<requirement_evidence>` block — both are exercised only by the fake-model test suite so far

### Phase 12 — The Analytics view, and the extraction that feeds it (done)

A third dashboard route, `#/analytics`, that reads the postings the candidate has already applied to
and answers one question: **which keywords do these roles ask for, and which of them does the Profile
fail to evidence?** Gap analysis, not market intel — the only postings djobi holds are ones already
saved as an Application, so this is a retrospective on the candidate's own history and must not be
dressed as a survey of the market.

The data is already there and already loaded. Every `applications` row carries a `jobInfo` snapshot
with `keywords` and `requirements`, `useApplicationStore` pulls the whole history into one array on
every visit, and `packages/shared/src/keywordCoverage.ts` already knows how to ask whether a resume
evidences a term. The view itself is an aggregation over facts the app holds, with **no LLM call and
no new endpoint** — the model already ran, at extraction time, and the snapshot is what it left
behind.

The second half of the phase is upstream, in `extractJob`, and it is here rather than in a later
phase for one reason: **`applications` never stores the job description.** The row keeps `jobInfo`,
`tailoredResume` and `answers` — the outputs — and the posting text is discarded when the run ends.
So no extraction improvement can ever be backfilled: each one starts helping only the rows saved
after it ships, and every month of delay is a month of postings permanently frozen at today's
fidelity. Whether to start storing the description — which would turn all of this into re-runnable
work — is a real question this phase deliberately does not answer; see _Known loose ends_.

Decisions — the view:

- **Client-side aggregation over the loaded array — no endpoint, no migration, no store method.**
  `ApplicationsList` already filters in the browser on the stated grounds that this is a personal-scale
  dataset and query parameters would be inventing backend work; the same reasoning covers a `useMemo`
  over the same array. The whole view is therefore exercisable through `createFixtureDashboardClient`
  with no network. Revisit only if a history reaches thousands of rows.
- **The range filters `Application.createdAt` — when the candidate _saved_ it, not when the posting
  was published.** djobi never captures a posting date; the schema.org `datePosted` sitting beside the
  description in `findJobPostings` was considered and **deliberately not captured**, because the
  question this page answers is "what have I been applying to lately", which is a fact about the
  candidate's own activity. The UI says "applications saved in the last N days" and claims nothing
  about the market.
- **The cutoff is local midnight, pinned once per mount.** `rangeStart(range, today)` returns local
  midnight of `today − (n − 1)`, so "past 7 days" is seven calendar days with today as the last — not
  eight. `today` is captured once in a lazy `useState`, never a `useMemo`, so nothing re-aggregates as
  the clock moves and a range does not silently shift under the reader mid-session. The cost is that a
  dashboard left open past midnight keeps yesterday's boundary until reload; that is the stability the
  fixed boundary is for. Local rather than UTC because a cutoff that jumps by hours with the reader's
  timezone is a cutoff nobody can predict.
- **Ranges are `7d | 14d | 30d | 60d`, default `7d`, and live in the URL** alongside `?stage=`, parsed
  strictly with a fallback exactly as `?stage=banana` is handled in `useHashRoute`. Both are intents
  the candidate expressed, so both survive a copied link — the same line `?show=` sits on the other
  side of.
- **The stage filter is the list's own `<FilterPills>` over `STAGE_FILTERS`.** Same component, same
  labels, same `stageFilterOf` normalisation, so "what did the postings that rejected me ask for,
  versus the ones that got me a phone screen" costs one click and no new design. Every row in range
  counts by default, `source: 'manual'` included: a manual row carries a real extracted `jobInfo` and
  is "a real application, not a lesser one" (see `ApplicationSourceSchema`), so excluding it would drop
  genuine postings.
- **Keywords group by `normalizeLabel` and display their most frequent original spelling.**
  Normalisation is a matching concern and belongs to matching; a table of lowercased proper nouns reads
  as a bug to the exact person reading it. Aliasing is not solved here at all — it is solved upstream,
  in the extraction prompt (below), which is the only place a synonym can be collapsed before it
  becomes two rows nothing can merge.
- **Coverage is asked once per distinct keyword, against the Profile — not rolled up from the stored
  resumes.** `keywordCoverage(baseResumeOf(profile), { …, keywords: distinct }, profile)`. Rolling up
  per-application verdicts instead would report variance in the tailorer rather than gaps in the
  candidate — the same keyword can come back `skills` for one posting and `missing` for another purely
  because tailoring differs — and the remedy the report points at is Profile-side either way.
- **The reachable verdicts on this path are `skills | experience | missing`, and `profile-experience`
  is unreachable by construction.** `keywordCoverage` searches skills, then the _resume's_ bullets,
  then the Profile's, first hit winning — and `baseResumeOf` copies the Profile's bullets verbatim, so
  the second search always hits before the third can. `profile-experience` exists to name a keyword the
  Profile has and _this resume dropped_, which cannot happen when the resume is the Profile. The badge
  therefore reads `skills` and `experience` as two flavours of covered and `missing` as the gap; the
  **Gaps only** toggle is `verdict === 'missing'`. Writing the analytics code against
  `profile-experience` would produce a filter that silently matches nothing.
- **The report is a ranked bar list, not a chart and not a score.** Count descending, alphabetical
  tie-break so ordering is stable across renders, proportional bars in CSS, top 25 with a Load more.
  No chart dependency: two routes did not pay for `react-router` and one table does not pay for a
  charting library. A **Gaps only** toggle narrows the same table to `missing`, which is the one thing
  frequency ordering cannot surface on its own — a keyword the Profile lacks can otherwise sit at row
  nineteen. It stays a list of gaps rather than a coverage percentage, for the reason the panel's
  Coverage Report already states: a number on screen is a number someone will raise, and the only
  dishonest way to raise this one is keyword stuffing.
- **A keyword's count is postings that asked, not mentions.** One `Set` per application before
  counting, so a posting listing a term twice still counts once — otherwise the bar measures how
  repetitive a posting was.
- **Requirement _text_ still gets a readable list; only its structured fields aggregate.** Whole
  sentences ("5+ years building distributed systems") do not repeat across postings, so counting
  identical strings yields a column of ones that looks like analysis and is not. They render grouped by
  posting, newest first, each linking to `#/applications/:id`; selecting a keyword row narrows the
  panel to postings carrying that keyword and highlights the term. What _is_ aggregable is the
  structure the extraction change below adds — how many postings marked something required rather than
  preferred, and the distribution of stated years — and only for rows extracted after it ships.
  That selection is component state rather than URL state: a transient reading position, not a stated
  intent, the same split `?show=` is on.
- **The requirements panel is its own scroll region, not part of the page's.** A busy 60-day range can
  hold 100–200 postings, each rendering several requirement lines — full-height on the page would make
  the panel scroll past the keyword list beside it and swallow the page's own scroll entirely. The panel
  body gets a bounded `max-height` and `overflow-y: auto`, so it scrolls independently and the page
  around it stays put — the two-column grid keeps both panels roughly level regardless of how long the
  right one's content runs.
- **Revealing more postings is scroll-triggered, not a click, and deliberately not the `?show=` /
  Load-more pattern the list and the keyword table use.** Those two are short, flat lists a click is
  proportionate to; a requirements read is scanning a scrollable feed, and stopping to click every 20
  rows breaks that. An `IntersectionObserver` watches a sentinel at the end of the rendered postings,
  with **`root` set to the panel's own scrolling element** — the default `root: null` observes the
  _page's_ viewport, which would fire while the panel is scrolled internally but the page hasn't moved,
  or never fire if the page never scrolls that far. Getting `root` wrong is the whole bug this decision
  exists to avoid.
- **There is no real loading state to show, and the panel must not fake one.** Every posting is already
  in the array `useApplicationStore` loaded — revealing more is a synchronous slice, not a fetch, so a
  spinner here would be theatre over work that isn't happening. What genuinely costs something is
  mounting 100+ requirement cards' worth of DOM at once, which the batching avoids by construction:
  render the first ~20 postings, and let the sentinel grow that count as the reader approaches it.
  A `Loading more…` line may appear for a single frame purely to smooth the render, never as a stand-in
  for network time that doesn't exist.
- **The revealed count resets when the filter set changes and lives in component state, never the
  URL.** A stage, range or keyword-selection change collapses back to the first batch — the same rule
  `listPath` enforces for `?show=` on the applications list, for the same reason: a revealed count
  belongs to a filtered result set and cannot be allowed to outlive it. It stays out of the URL because
  it is scroll position, not an expressed intent — the same distinction that already keeps the keyword
  selection out of the URL.
- **The scroll container needs its own keyboard path.** A `<div>` with `overflow-y: auto` is not
  reachable by Tab unless it is given `tabindex="0"`; without that, a keyboard user with no scroll wheel
  has no way to move it and no way to trigger the sentinel at all.
- **`getProfile(): Promise<Profile | null>` is a fourth `DashboardClient` method, fetched only by this
  view.** It is the first thing the dashboard needs beyond Applications, and the list and detail views
  must not start paying for it.
- **`null` is a valid answer from `GET /profile`, not a failure, and the two must not be merged.** The
  route answers `200 null` for a candidate who has not set a Profile up (`routes/profile.ts`, asserted
  in `routes/profile.test.ts`), so the response parses through `MaybeProfileSchema` — the nullable
  schema `apps/extension/src/lib/backendClient.ts` already uses for the same call — rather than
  `ProfileSchema`, which would turn the empty case into a parse error. Three states, three renderings:
  **ready** shows coverage badges; **null** shows a "set up your Profile" notice explaining that
  coverage needs one; **unreachable** shows a failure notice. All three keep the frequency table and
  the requirements panel rendering, because analytics without coverage is still worth reading and a
  page that fails whole because half of it is unavailable is the worse answer.
- **Five states, kept distinct.** No applications at all; none in the selected range or stage (with the
  range control still visible and enabled — never hide the control that would fix the emptiness);
  applications in range whose `jobInfo.keywords` are all empty, where the requirements panel still
  renders; no Profile saved; and the Profile unreachable. The last two are notices beside a working
  table rather than empty states, and they say different things — one is "do this", the other is "try
  again".
- **The detail page's back link follows the index the reader came from.** `App` remembers only the last
  _list_ URL today and `ApplicationDetail` hard-codes "← Applications", so a posting opened from the
  requirements panel sends the reader to the applications list and throws away the range, the stage and
  the keyword they were reading. The remembered value becomes `{ href, label }`, written by whichever
  index route rendered last, and the detail page renders the label it is given. This is the same
  reasoning that put `listHref` in a ref to begin with — the in-page link has no history to read — and
  it stays a ref for the same reason: it only ever feeds the next render's href.
- **`fixtures.ts` is left alone and the one component test fakes the clock.** Its `createdAt` values are
  absolute and already months stale, so every range over them matches nothing — but making them
  relative to `now` would make the list and detail assertions non-deterministic across a midnight
  boundary. `rangeStart` taking `today` as a parameter is what keeps the aggregation tests clock-free;
  only the test that mounts the view sets the system time.

Decisions — the extraction that feeds it:

- **Keyword hygiene is a prompt change, and it is the highest-value line in this phase.** The current
  instruction says nothing about the _form_ of a keyword, so the extractor emits whatever the posting
  said: `K8s` from one and `Kubernetes` from another, `React.js` and `React`. Analytics fragments on
  exactly that, and no downstream normalisation can merge them — `normalizeLabel` only folds case and
  whitespace. The prompt now asks for the **canonical, expanded, industry-standard name** (`Kubernetes`
  not `K8s`, `JavaScript` not `JS`), one or two words per term, and roughly fifteen terms at most.
  Collapsing a synonym at the moment of extraction is the only place it can be done without an alias
  table, which `keywordCoverage.ts` argues against at length and this phase does not reopen.
- **`requirements` becomes `{ text, kind, yearsOfExperience }`.** `kind` is
  `'required' | 'preferred' | 'unspecified'` — the third value matters as much as the first two, since
  a posting frequently states neither heading and the extractor must say so rather than guess.
  `'required'`/`'preferred'` come from what the posting states plainly under its own headings
  ("Requirements" versus "Nice to have"), which the current flat `string[]` throws away.
  `yearsOfExperience` is a nullable number, and null is the common case. Together they are what let
  analytics say "9 of 14 postings required this" instead of listing sentences — and denominators must
  count only rows that actually carry the field, never treat `unspecified` as a fourth kind of `false`.
- **`keywords` becomes `{ term, category }`**, where category is one of a small closed set
  (`language | framework | tool | platform | domain | soft-skill`). A flat ranked list mixes
  `TypeScript` with `stakeholder management`; grouped, "my gaps are all in platform" becomes a thing
  the page can show rather than something the reader has to notice. `soft-skill` gets no coverage
  badge: `keywordCoverage`'s literal `containsAsWords` match cannot conclude a Profile lacks
  "leadership" because it says "mentored" instead, and a wrong `missing` verdict is worse than an
  unscored row.
- **Both widenings need a tolerant read, not a migration.** `jobInfo` is jsonb read back exactly as
  written, so every existing row returns bare strings. `JobInfoSchema` accepts a union — a string lifts
  to `{ text, kind: 'unspecified', yearsOfExperience: null }` and `{ term, category: null }` — which is
  the same shape of answer `parseProfile` gives for profiles saved before a field existed. `kind`
  defaults to `'unspecified'`, never `'required'`: a requirement stored before this change may well have
  been a nice-to-have, and stamping every old row `'required'` fabricates a fact the posting never
  stated, the same guess the extraction prompt already forbids on the way in. A mixed history is the
  normal case for months and must render as ordinary data, never as "unknown" noise.
- **The widened `JobInfo` reaches three prompts for free, and that is mostly a gift.**
  `promptContext.jobContext` is `JSON.stringify(jobInfo)`, so `tailorResume`, `answerQuestions` and
  `answerChat` all start seeing `kind` and `category` with no call-site change — and tailoring, told to
  emphasize requirements, can now tell a hard requirement from a nice-to-have. The cost: `<job_info>`
  sits in the **varying tail** for `tailorResume`, not the cached prefix, so a richer object is more
  uncached input tokens on every run. Small against a Profile, but it is the half that is paid for
  every time.
- **`extractJob` runs on `gemini-3.1-flash-lite`, so richer output is nearly free in money and the
  real cost is latency** — it is the serial gate for the whole Analysis Step. Structured requirements
  are more output tokens per call; measure before assuming they are lost in the noise.
- **Non-fabrication is the risk this change adds, and the existing prompt rule is what covers it.**
  "Only use information present in the text — leave a field null rather than guessing" now governs a
  number, and a hallucinated `yearsOfExperience: 5` would look more authoritative on an analytics page
  than a wrong keyword ever could. `kind` defaults to `'required'` only when the posting draws no
  distinction — never as a way to avoid saying null.

- [x] `packages/shared/src/schemas.ts`: widen `JobInfoSchema.requirements` and `.keywords`, each behind
      a union that lifts a bare string to the new shape, so stored jsonb keeps parsing. Tests for both
      old and new rows. Landed together with the ripple this forces: `keywordCoverage.ts` reads
      `keyword.term`; `dashboard/lib/fixtures.ts` and `extension/panel/LogApplication.test.tsx` and
      every backend test fixturing a `JobInfo` now build the canonical object shape (the Stripe fixture
      row is deliberately left as bare strings and run through `JobInfoSchema.parse` to keep the
      tolerant read exercised); `ApplicationDetail.tsx`'s requirements/keywords lists render `.text`/
      `.term` (category/kind-aware rendering is still open, for the view work below). Suite green at
      **1246 tests** (204 shared / 16 http-client / 233 backend / 676 extension / 117 dashboard).
- [x] `apps/backend/src/llm/extractJob.ts`: canonical-name/length/count guidance for keywords, and the
      required-versus-preferred and stated-years instructions for requirements, with null over a guess
      restated for the number
- [x] Live: one extraction against a real posting per shape change, run three times against
      `gemini-3.1-flash-lite` (a synthetic backend posting mentioning "K8s", "Postgres", "5+ years").
      `K8s` → `Kubernetes`, `Postgres` → `PostgreSQL`, `Kafka` → `Apache Kafka` every run; "Requirements"
      vs "Nice to have" mapped cleanly to `required`/`preferred`; `yearsOfExperience` came back `5` for
      the one requirement that stated a number and `null` for the rest — no invented figures across any
      run. Notably the schema's own field `.describe()`s already got most of this right even against the
      _old_ userContent text (verified by swapping the prompt back to its pre-change form for one run);
      the new paragraphs are reinforcement, not the sole mechanism — worth remembering if a future
      prompt trim is tempting.
- [x] Measure the Analysis Step's serial gate before and after; `extractJob` is what every other step
      waits on. One old-prompt run: 2507ms / 602 output tokens. Three new-prompt runs: 2023–3240ms
      (mean ~2594ms) / 551–625 output tokens. No systematic regression — the spread is ordinary
      run-to-run jitter, not a richer-schema tax; this was a small sample (n=1 vs n=3) against one
      posting, not a load test.
- [x] `panel/LogApplication.tsx` (extracted-counts line) and `dashboard/views/ApplicationDetail.tsx`
      (requirements list) render the new shape, including rows still holding the old one.
      `LogApplication.tsx` needed no change — it only ever read `.length`, which is shape-agnostic.
      `ApplicationDetail.tsx` now renders a `requirement-kind` badge (suppressed for `unspecified`,
      the common case), the stated years, and a keyword's category alongside its term; covered by a
      new `App.test.tsx` case against the `app-brex` fixture row
- [x] `apps/dashboard/src/lib/analytics.ts`: `RANGES`, `rangeStart(range, today)`, the keyword
      aggregation (count = postings that asked, not mentions, grouped by `normalizeLabel`, most
      frequent original spelling and category displayed), and `requirementKindCounts` /
      `yearsOfExperienceDistribution` as the required/preferred and years roll-up over the rows that
      carry it. Pure, tested directly (17 cases), no clock and no React
- [x] `lib/useHashRoute.ts`: a third `Route` variant (`AnalyticsRoute`), `?range=` parsing with a
      strict fallback to `DEFAULT_RANGE`, `analyticsPath(range, stage)` as its inverse, and `?stage=`
      reused via a `stageFilterFrom` helper shared with the list route rather than re-invented
- [x] `lib/dashboardClient.ts`: `getProfile(): Promise<Profile | null>` on the interface, the HTTP impl
      against the existing `GET /profile` parsing through `MaybeProfileSchema`, and a fixture impl
      (defaulting to `null`, overridable) that can answer `null` so the no-Profile rendering is
      exercised. `fixtures.ts` gained `fixtureProfile`, whose skills deliberately cover some
      `fixtureApplications` keywords and miss others
- [x] `views/Analytics.tsx`: range control (own pill row over `RANGES`, not `FilterPills` — there is
      no "all ranges" state for it to represent), the list's own `FilterPills`/`STAGE_FILTERS` for the
      stage pill, a ranked bar list with `coverage-badge` (skills/experience/missing) and a category
      shown per row, a `Gaps only` checkbox (disabled until the Profile is `ready`), the requirements
      panel, and the five states — the true-empty and no-match-in-range cases render inline in the same
      ternary chain `ApplicationsList` uses, so the range/stage controls stay mounted through both
      rather than only through the second (an early return for the true-empty case was tried first and
      reverted for this reason)
- [x] Requirements panel (`components/RequirementsPanel.tsx` + `lib/useRevealOnScroll.ts`): bounded
      `max-height` + internal `overflow-y: auto`, an `IntersectionObserver` hook whose `root` is that
      scroll element (not the viewport), batched reveal (`PAGE_SIZE` postings), and a reset of the
      revealed count via an explicit `resetKey` string the caller composes from range/stage/keyword
      selection. `tabindex="0"` on the scroll container. Its own test file mocks `IntersectionObserver`
      through a small fake driven by hand (jsdom has none — and a global no-op stub now lives in
      `vitest.setup.ts` so every other test that merely _mounts_ Analytics doesn't crash), asserts the
      second batch renders only once the sentinel intersects, and asserts a `resetKey` change collapses
      back to the first batch while an unrelated rerender does not
- [x] `App.tsx`: nav row in `page-header__inner` — Applications / Analytics — between the brand lockup
      and the theme toggle, `margin-right: auto` keeping the toggle pinned to the far edge regardless of
      how many views the nav grows to. A peer of `.page`, not inside it, so it belongs to the chrome
- [x] `App.tsx` / `views/ApplicationDetail.tsx`: the remembered back target is now
      `{ href: string; label: string }` in a ref (`backTarget`), written by whichever index route
      rendered last; `ApplicationDetail`'s prop is `back` (was `backHref`) and its heading reads
      `← {back.label}`. `keywordCoverage`'s `jobInfo` parameter was narrowed to
      `Pick<JobInfo, 'keywords'>` so Analytics can pass a synthesized `{ keywords: distinct }`
      without fabricating the rest of a `JobInfo` it doesn't have
- [x] `App.css`: `.nav`/`.nav-link`, an `.analytics-*` set (`-grid`, `-panel`/`-panel__head`/
      `-panel__foot`, `-controls`/`-control-group`/`-control-label`, `-toggle`/`-toggle__track`,
      `-summary`, `-notice`/`-notice--action`/`-notice--error`, `-category`, `-rows`/`-row`/
      `-row__term`/`-row__count`, `-badge`/`-badge--skills`/`-badge--experience`/`-badge--missing`,
      `-posting`/`-posting__head`/`-posting__title`/`-posting__meta`, `-reqs`/`-req`/`-req__text`/
      `-req__years`, `-empty`, `-reqs-scroll`, `-summary-strip`), and two new tokens (`--bar`,
      `--bar-gap`). Reworked after a design-alignment pass — see below — against the "Keyword Gaps"
      mockup artifact, which specifies these down to the exact colour values
- [x] **Design-alignment pass (post-implementation):** the view above was first built straight from
      this document's prose, without the "Keyword Gaps" mockup artifact the candidate had separately
      published — nobody had linked the two. Once shown it, rebuilt to match: category-grouped
      keyword sections (not an inline per-row label), the frequency bar as the row's own full-width
      background rather than a side track, three-colour coverage badges (skills=green,
      experience=blue, missing=red, previously skills/experience shared one colour), a summary strip
      (postings / distinct keywords / not-evidenced count / date range), structured notice cards
      (icon + title + description) replacing plain banner text, in-sentence `<mark>` highlighting of
      the selected keyword inside each requirement (via `String.split` on a capturing regex, not
      `dangerouslySetInnerHTML`) replacing a separate "Matched: X" tag, card-styled panels with a
      head/foot, and labeled control groups ("Saved in the last" / "Stage"). `RequirementsPanel` also
      absorbed its own panel head (dynamic title/subtitle) and the required/preferred/years roll-up,
      since both are derived from state only it holds. A same-session code-review pass separately
      fixed a `useRevealOnScroll` ref that could go stale (moved to callback refs), a dead empty-state
      branch in `RequirementsPanel`, stage-pill counts that ignored the active range, and raw enum
      text (`soft-skill`) shown unlabeled — the last of which is a `KEYWORD_CATEGORY_LABELS` in
      `lib/stages.ts` (singular, for the detail page's per-tag use) plus a separate plural
      `CATEGORY_GROUP_LABELS` local to `Analytics.tsx` (for its section headings)
- [x] **"Min. appearances" filter (post-mockup addition, user-requested; revised twice).** First built
      as a fifth control in `.analytics-controls` with fixed threshold options via `<select>`; moved
      into the Keywords panel's own `.analytics-panel__head` (replacing the static "Postings that
      asked" subtitle) and rebuilt as a hand-rolled +/− stepper accepting any integer ≥ 1, per
      follow-up feedback that it belongs on the panel it filters and should not be capped to preset
      values. It starts at `5`, while the stepper still accepts any integer ≥ 1.
      `row.count >= minAppearances` composes with `Gaps only` (both narrow the same `rows`
      independently) and resets the keyword table's revealed-batch count on change, the same rule
      range/stage/Gaps only already follow. The empty-table message names whichever of the two
      filters is worth loosening. Styled to match the page's existing conventions rather than native
      control chrome: a pill-shaped button pair (matching `.filter-pill`'s radius) with a
      primary-tinted hover (matching `.analytics-link-button`/`.nav-link`) and a pill-badge value
      display (matching `.filter-pill__count`/`.analytics-badge`'s weight)
- [x] **Requirements panel polish (user-requested).** `.analytics-grid`'s columns went from
      `1.15fr/1fr` to `1fr/1.3fr` — Requirements holds full sentences and benefits from the extra
      width more than Keywords' short single-line rows do — and its scroll region's `max-height`
      grew from `70vh` to `78vh`. Each posting's header now colours the company name with `--primary`
      (bold) ahead of the role title (regular weight), on one wrapping line rather than a flat string
      — matching the "Keyword Gaps" mockup's single-line title exactly, confirmed against a
      screenshot of it mid-change, with only the colour split added on top. An `unspecified`
      requirement — no `required`/`preferred` badge — previously had nothing marking it as a list
      item at all, since `.analytics-reqs` sets `list-style: none` for the grid layout the badge
      column needs; it now gets a plain `•` in that column (`.analytics-req__bullet`) so every row
      reads as one regardless of whether it also carries a kind badge
- [x] `dashboard/lib/fixtures.ts` and `extension/lib/testFixtures.ts`: enough rows in the **new** shape
      to exercise category grouping and the required/preferred roll-up, while keeping at least one in
      the old shape so the tolerant read stays covered. Landed in the schema-widening pass:
      `fixtures.ts`'s six autofill rows spread across every `kind`/`category`, the Stripe row is
      legacy bare strings run through `JobInfoSchema.parse`. `testFixtures.ts` stays intentionally
      empty by its own stated design — the new-shape examples for extension tests live in the
      individual test files that need non-empty `jobInfo` (`LogApplication.test.tsx`,
      `applicationPipeline.test.ts`), not in the shared neutral fixture
- [ ] Built test-first, same as the rest. Not followed for this phase: implementation landed first,
      with tests written immediately after against the same behavior, unit by unit. Coverage is
      real (204/16/234/676/151→169 across the five packages by the end) but the red-green discipline
      itself was skipped — flagged here rather than checked off under a claim that doesn't hold

#### Phase 12.3 — Outcomes and stored evidence in Analytics (done)

Phase 12 read two fields of every saved row (`jobInfo.keywords`, `jobInfo.requirements`) and used
`stage` only as a filter. Two things the record already held were therefore never reported: whether
a posting ever came back, and the per-requirement verdicts `requirementEvidence` computes and
persists at every save. Both are pure additions over the array the view already has — no endpoint,
no schema change, no migration.

- **A response rate, with pending applications excluded from the denominator.** `outcomeOf` maps a
  stage onto `responded` / `no-response` / `pending`; the rate is `responded / (responded +
noResponse)`, and `applied` is carried alongside as `pending` rather than counted as a rejection.
  Dividing by pending rows would report a collapsing rate that measures nothing but recency — the
  censoring problem, and the one way this number could actively mislead.
- **The mapping leans on `rejected` and `rejected_ats` staying distinct**, which is the reason
  `ApplicationStageSchema` carries both. A candidate who marks every rejection `rejected` reads as a
  100% response rate, and nothing here can detect that; guessing around it would fabricate an
  outcome the record never stated. `stage` is also a scalar with no history, so a `rejected` row
  cannot say how far it got — this reports _whether_ a posting responded, never how far or how fast.
- **No rate is printed below `MIN_DECIDED_FOR_RATE` (5) resolved postings**; it reads `—` and its
  tooltip says why. Three applications cannot distinguish a 33% rate from
  a 67% one. The fixture set never reaches the threshold in any range, which is itself the honest
  reading of eight rows across three months — the view tests that need a rendered percentage build
  their own set rather than lowering the bar to make the fixtures qualify.
- **The rate disappears entirely while a stage filter is on**, rather than being shown with a caveat.
  Filtering to `offer` selects the population on the very variable being measured and reports 100%;
  filtering to `rejected` reports 0%. Both look like findings. A response rate is only a fact about
  an unselected population.
- **A per-keyword rate is a place to look, not a cause.** No posting asks for one keyword, so a
  term's rate is the rate of postings that _happened_ to ask for it, confounded with everything else
  those postings wanted. Only terms trailing the page's own baseline by ≥10 points are tinted — a
  table where every rate is coloured is a table where the colour means nothing — and deliberately in
  a new `--warning` token rather than the `--danger` the `missing` coverage badge uses: a low rate
  must not read as loud as a stated gap.
- **`requirementEvidence` is read back in aggregate for the first time.** It is strictly better than
  the keyword coverage beside it for the same reason the module exists: coverage answers "is this
  term in my profile", this answers "does the resume I actually sent evidence what the posting
  actually asked for". `omitted-profile-evidence` is the verdict worth surfacing — the Profile had
  the bullet and the tailored resume dropped it, a selection the candidate can fix rather than a
  skill they lack — so the requirements panel badges it and quotes the dropped bullet inline.
- **The roll-up states its own denominator.** `requirementEvidence` is `null` for every row saved
  before the field existed and for any row whose Profile could not be read at save time, and nothing
  backfills one; `unscoredPostings` is reported rather than folded away, and the strip is suppressed
  entirely when no posting in range carries evidence — a strip of zeros over unscored rows would
  read as "nothing was dropped" when the truth is "nothing was checked". Same rule
  `requirementKindCounts` already follows for `unspecified`.
- **Only the four non-`direct-evidence` verdicts get a badge**, the same suppression
  `ApplicationDetail` applies to the `unspecified` requirement kind: badging the good, common case
  buries the ones that mean something is wrong. The strip above them still counts **all five**, so
  it sums to the requirements it was drawn from — an omitted verdict there would leave a strip of
  zeros standing over rows visibly badged with the verdict it dropped.
- `fixtures.ts` gains exactly one scored row (`app-brex`, with a fourth requirement whose evidence
  the tailored resume dropped) and leaves the rest `null`, so the mixed history that is the normal
  case — and the caveat that reports it — are both exercised rather than assumed.

Still not answerable, and the reason is one missing field: `applications` records no
stage-transition timestamps (no `updatedAt`, no history), so time-to-response, funnel velocity and
"these have gone quiet" remain uncomputable. A `stageHistory` jsonb column written on every stage
PATCH — jsonb rather than new columns, matching `profiles.data` and the four Phase 12 fields — is
the unlock whenever those questions are worth having.

#### Phase 12.2 — Background enrichment (exploratory, not started)

Not part of the phase above. `extractJob` is a single synchronous call on a fast/cheap model, and
Phase 12's prompt changes (keyword hygiene, required/preferred, categories) are cheap enough to live
in that same call — there is nothing today worth deferring to a background job, and no background-job
infrastructure exists anywhere in `apps/backend` to defer it to.

This becomes worth exploring only if a **second, heavier extraction pass** is ever wanted — a
stronger model doing something `extractJob`'s fast model shouldn't be asked to do inline (semantic
keyword canonicalization, the taxonomy/versioning enrichment considered and declined above) — where
the cost is real enough that it shouldn't sit in the interactive Save path. Two things are
prerequisites, not part of the job itself — the first of which Phase 19 has since met:

- ~~**The raw job description has to start being stored**~~ — done, by Phase 19, after this was
  written: `raw_description` holds the posting text every save analyzed, and `extraction_version`
  says which prompt generation produced the row beside it. This prerequisite is met; a background
  job now has something real to run against.
- **The job should be a fire-and-forget call plus a nullable `enrichedAt` timestamp, not a queue.**
  At this app's save volume a lost enrichment on a backend restart is an acceptable, low-stakes
  miss — reprocessed later by a manual sweep over `rawDescription IS NOT NULL AND enrichedAt IS
NULL`, which doubles as the mechanism for re-running an improved prompt over old rows. A real job
  queue (retries, a persisted job table, a poll loop) is infrastructure this personal-scale tool has
  never needed elsewhere and shouldn't acquire for one optional enrichment call.

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

### Multi-tenant authentication (done except social login and cost control)

Turned djobi from a single-user local tool into a public product more than one person can sign into.
Decisions and the phase-by-phase log are in `docs/multi-tenant-auth.md`; the shape of what shipped:

- **Ownership in the data model landed first, with auth second.** `profiles` re-keyed to `user_id` as
  its primary key, `applications` gained a `user_id` column, and both indexes gained a `user_id`
  prefix — done while there was still exactly one tenant, so the scoping was reviewable and a mistake
  could not leak anything.
- **The mechanism is Better Auth, self-hosted against the existing Postgres**, so ownership stays a
  foreign key rather than a claim in someone else's token. Email/password is what actually works
  today; Google/GitHub OAuth (and the `chrome.identity.launchWebAuthFlow` + PKCE flow the extension
  would need for it) is deferred until a provider is registered — Better Auth's `bearer()` plugin
  already returns a session token on any successful sign-in, credential-based included, so the
  extension didn't need OAuth to get a working bearer token.
- **The Duplicate Guard indexes are user-scoped, as a correctness rule, not a performance one.**
  Unscoped, one user's saved application would stop another user's analysis and tell them they
  already applied to a job they have never seen.
- **One server-side `OPENROUTER_API_KEY` funds every signup — genuinely unresolved, not hardening to
  defer.** Neither BYOK nor per-user quotas is built; see `docs/multi-tenant-auth.md`'s Phase E.

### Phase 10 — A deep bullet bank, starred bullets, and a per-role cap (implemented; live verification pending)

Let the candidate keep **every** bullet they have ever written for a role — a dozen or fifteen, not
four — and make each resume a selection from that bank rather than the whole of it. Two controls
decide what lands: the candidate **stars** the bullets that must always appear, and a per-role
**cap** bounds how many more the model may add.

Before this phase every bullet on a role landed on every resume. `tailorResume` already permitted omission and
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
  report says "missing" about something the Profile already has, and the advice is wrong. The
  `profile-experience` verdict means a source bullet carries the keyword while this resume does not,
  and names the bullet worth starring. It deliberately does not claim the bullet was unselected:
  the stored resume drops source pointers, so a selected rewrite that omitted the keyword looks the
  same. Coverage still never feeds back into tailoring — that rule is load-bearing and is what keeps
  the report honest.
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

- [x] `packages/shared/src/schemas.ts`: `Profile.maxBulletsPerRole` (optional, schema default 6),
      `WorkExperience.maxBullets` (nullable, `null` = inherit) and `WorkExperience.starredIndices`
      (optional, default `[]`, `.refine()`d so every index resolves against `bullets`); all three in
      `EMPTY_PROFILE`. No `.max()` on `bullets`
- [x] Keep the three new fields out of the _resume_. They ride two paths that hand Profile entries
      straight to a `TailoredResume`: `baseResumeOf` returns `profile.workExperience` as-is, and
      `reconcileResume` spreads the whole profile entry. Neither re-parses, so they would land in
      `applications.tailoredResume` jsonb as stored fields of a resume, where they mean nothing.
      Project both entries explicitly instead of spreading
- [x] `apps/backend/src/llm/tailorResume.ts`: prompt states the cap as a maximum, forbids padding,
      instructs selection against `jobInfo.requirements`/`keywords`, marks starred bullets as already
      included and excluded from selection, and asks for ordered indices with `text` only on
      non-starred entries
- [x] `reconcileResume`: substitute `role.bullets[i]` verbatim for every starred index, require each
      to appear exactly once, truncate to `max(maxBullets ?? maxBulletsPerRole, starredIndices.length)`,
      and keep returning plain `string[]`
- [x] `tailorResume`: move instructions + Profile into `cachedPrefix` and leave `<job_info>` in the
      varying tail, matching `answerQuestions`
- [ ] Live: confirm repeated tailoring reports cache reads in structured-call metrics
- [x] `outputTokenLimit`: re-derived from the effective cap rather than the unbounded source bank;
      stars cost less because their output carries no rewritten text
- [ ] Live: re-measure the output limit on a 15-bullet-per-role Profile before this ships
- [x] `packages/shared/src/keywordCoverage.ts`: fourth `CoverageVerdict` for a keyword evidenced only
      in a Profile bullet absent from this resume, plus the branch in `panel/CoverageReport.tsx` that
      says _star it_ rather than _add it to your Profile_
- [x] Options page: star toggle per bullet, per-role collapse, a bullet count, and the cap controls
      (Profile default plus per-role override). Deleting or inserting a bullet remaps
      `starredIndices` — one helper, its own tests. No drag-reordering: authored order stopped being
      resume order once the model took ordering
- [x] Confirm the two-page case recedes — a fixture that previously spilled should now fit, and one
      with more stars than its cap should still be allowed to spill
- [x] Built test-first, same as the rest

## Known loose ends

- ~~**The job description is never stored, so no extraction change can be backfilled.**~~ Decided and
  shipped by Phase 19: `raw_description` is a `text` column (migration `0008_numerous_doorman.sql`,
  `db/schema.ts`), and both save paths fill it — `applicationPayload.ts`'s manual entry from the
  pasted posting, its autofill entry from the text the run actually analyzed. `extractionVersion`
  ships alongside it, stamped from `EXTRACTION_VERSION`, so the rows a given prompt change predates
  are identifiable rather than merely re-runnable.
  **The reader now exists for a human, not yet for a sweep.** `ApplicationDetail`'s **Posting** tab
  renders a stored `rawDescription` as the text the Analysis Step was actually given — which is the
  copy that outlives the posting URL, and the only way to ask why extraction produced what it did.
  Its requirement list reads `requirementEvidence` back the same way, per requirement, through
  `components/RequirementList.tsx` (the verdict vocabulary now lives once, in `lib/stages.ts`'s
  `EVIDENCE_LABELS`, shared with the Analytics roll-up).
  What is still missing is the _machine_ reader: `scripts/evalExtraction.ts` judges a prompt change
  against its own hand-written `POSTINGS`, not against the candidate's history, and no sweep re-runs
  extraction over rows stamped with an older `extractionVersion`. `bulletProvenance` still has no
  reader at all.

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
