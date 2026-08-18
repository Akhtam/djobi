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

Everything below is built, tested and works end to end. Suite green at **436 tests** (104 shared /
51 backend / 281 extension), `pnpm test` from the repo root.

- **`packages/shared`** — the zod schemas and the rules both processes must agree on: `schemas.ts`
  (Profile, Job Info, Tailored Resume, Question Answer, Application), `detectedField.ts` (what a
  Detected Field is and how an answer gets back onto one), `wire.ts` (every route body, so drift
  between the two ends is a compile error), `labelMatching.ts` (when two labels are the same),
  `screeningAnswers.ts` / `preparedAnswers.ts` (the facts a Profile answers without a model).
- **`apps/backend`** — Hono on `127.0.0.1:5391`. Three LLM calls (`extractJob`, `tailorResume`,
  `answerQuestions`) through `structuredCall.ts`, a one-page-fitting resume PDF renderer, and
  Postgres persistence (Neon + Drizzle) for profiles and applications.
- **`apps/extension`** — MV3, Vite + `@crxjs/vite-plugin` + React. Content scripts detect the form
  (`detect.ts`) and classify its fields (`detectFields.ts`) and fill them (`fillForm.ts`); the
  service worker runs the pipeline (`applicationPipeline.ts`); the options page edits the Profile;
  the side panel is the review surface. Light/dark theme shared by both pages (`lib/theme.tsx`),
  persisted in `chrome.storage.local`.

The Application Pipeline as it runs today: **paste a job description → duplicate guard → Analysis
Step → review and edit → Fill Step → explicit Save Step.** The panel is hydrated from and
checkpointed to `lib/tabStore.ts` at every stage, so closing it mid-run loses nothing.

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
- **Application tracking:** `status` (draft/submitted) and `stage` (applied → phone_screen →
  interviewing → offer/rejected/withdrawn) are separate fields. Notes are a timestamped, categorized
  log (`technical` / `behavioral` / `general`) you append to, not a single overwritable text field —
  so old interview-question notes stay around as reference for future applications.
- **Process:** this project is built test-first (red → green, one vertical slice at a time) — see
  the `mattpocock-skills:tdd` skill. Continue that pattern for new routes/modules.
- **Repo:** pnpm workspace — `packages/shared` + `apps/backend` + `apps/extension`, with
  `apps/dashboard` planned (Phase 8). GitHub remote: `Akhtam/djobi`.

## Constraints that look like mistakes

Load-bearing, recorded nowhere else, and easy to "clean up" into a regression.

- `attachResumeFile` keeps a non-`DataTransfer` fallback branch (shadowing `.files` via
  `Object.defineProperty`) purely because **jsdom has no `DataTransfer` constructor** and no public
  `FileList` constructor either. Production takes the real `DataTransfer` path. This is a test
  environment constraint living in product code — don't simplify it away.
- **Cover-letter fields (`cover_letter_text` / `cover_letter_upload`) are detected but deliberately
  not filled.** `answerQuestions` is wired only to `question`-category fields. A scope decision,
  not an oversight.
- **The `??` vs `||` trap on the job-description box.** The textarea's display value, the
  Analyze-button disabled check, and the analyze payload must all read the _same_ expression. Use
  different operators in different places and the box either silently reverts the user's typing or
  lets a blank submission through.
- `pdf/renderResume.tsx` needs an explicit `import React from 'react'` — without a `tsconfig.json`
  in `apps/backend`, JSX uses the classic transform and `React.createElement` must resolve at
  runtime. Switch to the automatic runtime once a tsconfig exists.
- **A fill is only reported as landed if the page kept it.** `fillForm` re-reads each field after a
  300ms settle, because a controlled field whose `onChange` never fired reverts on the _next_
  render — an immediate re-read calls every failed fill a success. A fill also drives the full
  keystroke event sequence (`focus` → `InputEvent('input')` → `change` → `blur`/`focusout`), since
  form libraries commonly commit to the form model on blur; a value write plus `input` leaves the
  DOM looking right and the model empty, which an ATS reports on submit as a missing required field.
- **The resume PDF fits itself to one page** by re-rendering down a four-step density ladder, never
  touching `fontSize` — leading and whitespace are spendable, legibility is not. Past ~5 roles × 6
  bullets it returns two pages with all content rather than truncating. Every step sits inside a
  range sourced in `docs/resume-design-conventions.md`; the "fill 85–90% of the page" heuristic is
  **folklore** and is not one of them. A resume that comes out thin is a `tailorResume.ts` problem,
  not a stylesheet one.

## Planned

### Phase 7 — Application tracking data model (in progress)

Landed:

- [x] `ApplicationStageSchema`, `NoteSchema` / `NoteCategorySchema` / `NewNoteSchema`, and
      `stage`/`notes` on `ApplicationSchema`/`NewApplicationSchema` — with `ApplicationSnapshotSchema`
      (`NewApplication` minus stage/notes) as what a re-save is allowed to overwrite
- [x] Migration `0001_living_captain_stacy.sql` adding the `stage`/`notes` columns
- [x] `applicationsRepository.updateApplicationStage(id, stage)`

Left:

- [ ] `applicationsRepository.addApplicationNote(id, note)` — appends to the log, server-generated
      `id`/`createdAt`
- [ ] `PATCH /applications/:id/stage` route — body `{ stage }`
- [ ] `POST /applications/:id/notes` route — body `{ category, text }` (`NewNote`)
- Build test-first, same as the routes that already exist

### Phase 8 — Frontend dashboard (not started)

A local web app to browse past applications, see which resume/answers went to which job, and
track/update stage + notes. Depends on Phase 7's remaining routes.

- [ ] `apps/dashboard` — separate Vite + React app (own dev server, e.g. `localhost:5173`),
      **not** part of the extension — talks to the same backend on `127.0.0.1:5391`
- [ ] Backend needs CORS middleware added (`hono/cors`) — none exists, and the dashboard is a
      different origin than the backend
- [ ] Applications list view — table of company / role / stage (badge) / date, filterable by stage
- [ ] Application detail view — job info, tailored resume, drafted answers, notes log (filterable
      by category), stage selector, add-note form
- [ ] No LLM calls from the dashboard itself — pure read/write against existing + Phase 7 endpoints

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

- [ ] Every new Story is created with `id: ''`, but `QuestionAnswer.sourceStoryIds` references
      `Story.id` — so those references are useless whenever the candidate didn't type an id by hand.
      A behaviour change rather than a refactor, hence left alone; see `options/App.tsx`.
- [ ] **Worth exploring:** `profileRepository.saveProfile`'s upsert logic has zero test coverage
      (the route test mocks the whole repository away) — test it directly. Related:
      `applicationsRepository.toApplication` casts jsonb straight to typed fields while
      `profileRepository.getProfile` deliberately parses — two policies for the same hazard.
- [ ] **Speculative:** `tailorResume.ts` / `answerQuestions.ts` both hand-build the same
      `<base_profile>`/`<job_info>` prompt scaffold — extract a shared helper if a third
      writing-model call site appears (Phase 9 would be it).

## Known loose ends

- `pnpm --filter backend build` (`tsc -p tsconfig.json`) fails — there's no `tsconfig.json` in
  `apps/backend` at all (only `packages/shared` and `apps/extension` have one). Needs fixing before
  a real build/deploy is possible, and it's what forces the classic JSX transform in
  `renderResume.tsx`. `pnpm dev:backend` (via `tsx`) is unaffected.
- **There is no Ashby API oracle.** The one that existed only ever got 401s and was removed, along
  with its `api.ashbyhq.com` host permission. The unauthenticated GraphQL endpoint that _does_ work,
  its query and its response shape are written up in `background/apiDetectors.ts`'s own comment;
  rebuilding it needs `jobs.ashbyhq.com` in `host_permissions` and a POST body, which
  `AtsOracle.request` would have to start returning an `init` for again.
- **`packages/shared/src/screeningAnswers.ts` has no test file** — the only module in that package
  without one. `matchScreeningTopic`'s order-dependent matching (a question naming both work
  authorization and sponsorship must resolve to the former) is covered only indirectly, through
  `preparedAnswers`.
- Two Ashby questions still need a live browser check: whether `data-djobi-id` attributes survive an
  Ashby form re-mount (if not, `resolveField` returns null for every field), and how Ashby renders
  its four Boolean screening questions — native fieldset/radios and `role="combobox"` are handled,
  custom buttons are not.
- A test profile (`Jane Doe`) is sitting in the real `profiles` table from an early smoke test.
  Harmless — it gets overwritten by the real profile — but worth knowing it's there.
