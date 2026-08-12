# djobi — Progress

**What this is:** a Chrome extension that autofills job applications on ATS sites (Greenhouse,
Ashby, Lever, Workday, ...) with an AI-tailored resume and drafted answers to freeform questions —
plus a local dashboard for tracking which resume/answers went to which job, interview stage, and
notes (Phases 7-8, added 2026-08-07). Full architecture/design plan: `docs/architecture-plan.md`
(in git — summarized below; Phases 7-8 are new and only documented here so far).

**Read this file at the start of a new session** to pick up where the last one left off. Update it
as work happens — check items off, add new ones, don't let it go stale.

## Key decisions (see plan file / package READMEs for full detail)

- **Models:** `claude-haiku-4-5` for job-info extraction, `claude-sonnet-5` for resume tailoring
  and question answering.
- **DB:** Postgres on Neon (cloud), accessed via Drizzle ORM. The backend itself runs locally.
- **Structured output workaround:** the installed `@anthropic-ai/sdk` (0.68.0) has no
  `.messages.parse()` / `zodOutputFormat`. Every LLM call forces a tool call instead and validates
  the result with zod — see `apps/backend/src/llm/structuredCall.ts`.
- **Form filling:** one generic heuristic field-classifier, not per-ATS selectors.
- **Process:** this project is being built test-first (red → green, one vertical slice at a time)
  — see the `mattpocock-skills:tdd` skill. Continue that pattern for new routes/modules.
- **Repo:** pnpm workspace, `packages/shared` (zod schemas) + `apps/backend` (Hono) +
  `apps/extension` (MV3, Vite + `@crxjs/vite-plugin` + React) + `apps/dashboard` (planned, Phase 8:
  separate Vite + React web app, not part of the extension). GitHub remote: `Akhtam/djobi`.
  Current branch: `phase_6`.
- **Application tracking (Phase 7-8):** `status` (draft/submitted) and `stage` (applied →
  phone_screen → interviewing → offer/rejected/withdrawn) are separate fields. Notes are a
  timestamped, categorized log (`technical_questions` / `behavioral_questions` / `general`) you
  append to, not a single overwritable text field — so old interview-question notes stay around as
  reference for future applications.

## Checklist

### Phase 1 — Workspace scaffold

- [x] pnpm workspace (`pnpm-workspace.yaml`, root `package.json`)
- [x] `packages/shared` — zod schemas (`Profile` incl. `stories[]`, `JobInfo`, `TailoredResume`,
      `DetectedField`, `QuestionAnswer`), JSDoc'd, tested (25 tests), documented in its README
- [x] Prettier configured at workspace root (single quotes)

### Phase 2 — Backend skeleton ✅ done

- [x] Drizzle schema (`profiles`, `applications` tables) — `apps/backend/src/db/schema.ts`
- [x] Neon DB client, lazily initialized — `apps/backend/src/db/client.ts`
- [x] `apps/backend/src/app.ts` (testable Hono app instance, separate from the entrypoint)
- [x] `apps/backend/src/index.ts` — starts the server via `@hono/node-server` on `127.0.0.1:5391`
      (or `$PORT`); smoke-tested, fails routes gracefully (500, no crash) when env vars are missing
- [x] Real Neon project created, `apps/backend/.env` has `DATABASE_URL` (gitignored,
      `ANTHROPIC_API_KEY` still needs a real value before the LLM routes will work)
- [x] `drizzle-kit generate` + `drizzle-kit migrate` run against Neon — `profiles`/`applications`
      tables exist for real (migration: `src/db/migrations/0000_slimy_manta.sql`)
- [x] Full round trip verified live: `POST /profile` → `GET /profile` against the real Neon DB
- Note: a test profile (`Jane Doe`) is sitting in the real `profiles` table from the smoke test —
  harmless (gets overwritten by the real profile), but worth knowing it's there

### Phase 3 — LLM layer + routes ✅ done

- [x] `extractJob` (Haiku), `tailorResume` (Sonnet), `answerQuestions` (Sonnet) — all tested (9 tests)
- [x] `POST /extract-job` route — tested (3 tests)
- [x] `POST /tailor-resume` route — tested (2 tests), zod-validates `{ profile, jobInfo,
      priorApplicationsSummary? }` against `ProfileSchema`/`JobInfoSchema`
- [x] `POST /answer-questions` route — tested (2 tests), zod-validates `{ profile, jobInfo,
      questions }` (`questions` via an inline schema — `QuestionToAnswer` isn't in `@djobi/shared`)
- [x] `renderResumePdf(profile, tailoredResume)` — `apps/backend/src/pdf/renderResume.tsx`, a
      single `@react-pdf/renderer` template; contact info + education come from `profile` (not
      job-specific), skills/work-experience from `tailoredResume`. Tested (1 test, asserts
      real `%PDF-` output — no mocking, since there's no LLM/network involved)
- [x] `POST /render-resume-pdf` route — tested (2 tests), zod-validates `{ profile,
      tailoredResume }`, returns raw PDF bytes with `content-type: application/pdf`
- Note: no `tsconfig.json` in `apps/backend` (see Known loose ends) means JSX in
  `renderResume.tsx` uses the classic transform by default — needed an explicit `import React from
  'react'` for `React.createElement` to resolve at runtime; switch to the automatic runtime once a
  tsconfig exists.
- [x] **Derive LLM `input_schema` from zod** (2026-08-07, via
      `/mattpocock-skills:improve-codebase-architecture` → grilling → `/tdd`): `callStructured`
      (`structuredCall.ts`) now derives each tool's `input_schema` from `schema` via
      `zod-to-json-schema@3.24.6` (pinned exact — its peer dep is `zod: ^3.24.1`, an exact match for
      the installed zod; the newer `3.25.2` needs `zod ^3.25.28` and would've forced an unrelated
      bump), with `$refStrategy: 'none'` so the schema stays flat/self-contained (Anthropic's tool
      `input_schema` doesn't dereference `$ref`/`definitions`). Deleted the three hand-maintained
      JSON Schema blocks (`jobInfoInputSchema`, `workExperienceItemSchema` +
      `tailoredResumeInputSchema`, `answerQuestionsInputSchema`) along with the `inputSchema` field
      on `StructuredToolCallOptions` — nothing passes one anymore. New `structuredCall.test.ts`
      (didn't exist before; the module was only tested transitively and none of those tests looked
      at `input_schema`) asserts the derivation against a sample schema (nested object, array,
      nullable, `.describe()`) and that no `$ref` leaks through.

### Phase 4 — Profile + applications persistence ✅ done

- [x] `GET /profile` / `POST /profile` — tested (4 tests), backed by `db/profileRepository.ts`
- [x] `GET /applications`, `GET /applications/:id` — tested (4 tests), backed by
      `db/applicationsRepository.ts` (`listApplications`, `getApplicationById`)
- [x] `POST /applications` — tested (3 tests), zod-validates against `NewApplicationSchema`
      (`@djobi/shared` — `ApplicationSchema` minus `id`/`createdAt`, `status` defaults to `draft`),
      writes via `applicationsRepository.saveApplication`
- [x] `tailorResume`'s `priorApplicationsSummary` is now populated automatically: the
      `/tailor-resume` route calls `applicationsRepository.listApplicationsByCompany(jobInfo.company)`
      and builds a one-line-per-application summary before calling `tailorResume` — tested (3 tests,
      up from 2); the route no longer accepts a client-supplied `priorApplicationsSummary` in the
      body, since nothing sent one and the plan always intended this to be server-computed
- Fixed a pre-existing bug found while starting this phase: `app.ts` only mounted
  `extractJobRoute`/`profileRoute` — `tailor-resume`, `answer-questions`, and `render-resume-pdf`
  were never wired in despite having passing unit-level logic, so their route tests were 404ing (6
  failing tests). Wired all five routes in `app.ts`; full suite was green before phase 4 work began.

### Phase 5 — Chrome extension ✅ done

- [x] `apps/extension` scaffold: `package.json`, `tsconfig.json`, `vite.config.ts`, MV3
      `src/manifest.ts` (host permissions for the local backend + ATS content-script matches,
      background service worker, popup/options pages), builds clean via `pnpm --filter extension
      build` — infra, not TDD'd
- [x] `src/background/callBackend.ts` — posts JSON to the local backend
      (`http://127.0.0.1:5391<path>`), resolves with the parsed response, rejects with the
      backend's `{ error }` message on a non-ok response; tested (3 tests, up from 2 — added an
      optional `method` param, defaulting to `POST`, so `GET /profile` is reachable too)
- [x] `src/background/index.ts` relays `chrome.runtime.sendMessage({ path, body, method? })` to
      `callBackend`, responding `{ data }` / `{ error }`; tested (3 tests)
- [x] `src/lib/sendToBackground.ts` — the popup/options-side counterpart, wraps
      `chrome.runtime.sendMessage` in a promise; tested (3 tests)
- [x] Test infra: added `jsdom` + `@testing-library/react` + `@testing-library/jest-dom`
      devDependencies, switched `vitest.config.ts` to the `jsdom` environment (was `node`), added
      `vitest.setup.ts` (jest-dom matchers + RTL `cleanup` after each test)
- [x] Options page (`src/options/App.tsx`) — full profile onboarding form covering every
      `ProfileSchema` field: scalar fields (name/email/phone/location/links), plus
      add/edit/remove list UIs for skills, work experience, education, and stories. Loads the
      existing profile via `GET /profile` on mount (empty form if none saved yet), saves via
      `POST /profile`, shows a saved/error message. Tested (11 tests)
- [x] Popup (`src/popup/App.tsx`) — scoped down deliberately (see note below): shows a "set up
      your profile" prompt (with a button to open the options page) when no profile is saved, a
      "navigate to a supported page" prompt when the active tab isn't an ATS host, and a ready
      state otherwise. Tested (3 tests)
- [x] `src/lib/atsHosts.ts` — single source of truth for the ATS domain allowlist:
      `isSupportedAtsHost(hostname)` (tested, 3 tests) used by the popup, and `ATS_HOST_PATTERNS`
      (derived from the same domain list) now imported by `manifest.ts` instead of a duplicated
      array. Added the `activeTab` permission so the popup can read the active tab's URL.
- [x] Extension icons (16/48/128 px) generated as placeholder PNGs at
      `src/assets/icons/icon{16,48,128}.png`, wired into `manifest.ts`'s `icons` and
      `action.default_icon` — infra, not TDD'd
- Note: the popup's real job — reviewing/editing a detected job's tailored resume and drafted
  answers — depends on data Phase 6 (content script) doesn't produce yet. Decided with the user to
  scope the popup down to profile-status/page-support plumbing now and build the actual review UI
  in Phase 6 once there's real data to review, rather than build it against an imagined contract.

### Phase 6 — Content scripts ✅ done, end-to-end

- [x] `src/content/detect.ts` — `isJobApplicationPage(doc)`: page-shape heuristic (does a form on
      the page have a resume file-upload input?) layered on top of the host-level allowlist that
      already gates content-script injection via `manifest.ts`. Tested (3 tests)
- [x] `src/content/scrapeJob.ts` — `scrapePageText(doc)`: readability heuristic for `/extract-job`
      input — `<main>`, then `[role="main"]`, falling back to `document.body`. Tested (3 tests)
- [x] `src/content/detectFields.ts` — `detectFields(doc)`: classifies every candidate-fillable
      `input`/`textarea`/`select` into a `DetectedField` (`@djobi/shared`'s `FieldCategory` enum)
      via keyword-matching a `<label for>`/aria-label/placeholder/name/id signal string; file
      inputs classified by upload type, unmatched question-shaped textareas classified as
      `question`, hidden/submit/button/reset/image inputs skipped. Tested (6 tests). Elements
      without a native `id` are tagged with a `data-djobi-id` attribute so `selector` reliably
      resolves back to the element — the initial `nth-of-type`-based selector was wrong (index was
      global across all fields, not per-parent-per-tag) and a test caught it before it shipped
- [x] `src/content/fillForm.ts` — `fillForm(doc, fields, values)` sets each field's value (keyed by
      `DetectedField.id`) and dispatches `input`/`change`, skipping fields with no supplied value
      or an unresolvable selector; `attachResumeFile(input, file)` attaches a resume file. Tested
      (3 tests)
- Deviation from `docs/architecture-plan.md`'s literal `DataTransfer` snippet for resume upload:
  jsdom (this project's test environment) doesn't implement `DataTransfer` at all, and there's no
  public `FileList` constructor to hand back from a polyfilled one either way — so the documented
  snippet can't be exercised by a real test. `attachResumeFile` instead uses
  `Object.defineProperty(input, 'files', { value: fileListLike, configurable: true })`, which
  shadows the inherited (read-only) `files` accessor with an own data property. This works
  identically in real Chrome (`files` is a configurable, non-`[Unforgeable]` IDL attribute) and is
  the same technique DOM testing/automation libraries use for this exact browser-API gap
- **End-to-end wiring** (content script → background → popup review UI → fill-on-confirm →
  `/applications`), completing the note deferred above and in Phase 5:
  - [x] `src/background/jobPageStore.ts` — per-tab `Map`-backed store (`setJobPageData`/
        `getJobPageData`), pure and tested without mocking `chrome` (2 tests)
  - [x] `src/background/index.ts` — the legacy untyped `{ path, body, method? }` backend relay is
        unchanged; new messages route via a `type` discriminator: `REPORT_JOB_PAGE` (content
        script → background, stores by `sender.tab.id`), `GET_JOB_PAGE_DATA` (popup → background,
        `{ tabId }` → stored data or `null`), `FILL_FORM` (popup → background →
        `chrome.tabs.sendMessage(tabId, ...)` → that tab's content script, response relayed back).
        Tested (3 new tests, 6 total)
  - [x] `src/content/index.ts` — no longer a stub: on load, if `isJobApplicationPage`, scrapes +
        detects fields and sends `REPORT_JOB_PAGE`; always listens for `FILL_FORM` and calls
        `fillForm`/`attachResumeFile` (reconstructing a `File` from the message's `{ name, type,
        bytes }`, since binary data crossing the message boundary can't carry a real `File`).
        Tested (4 tests)
  - [x] `src/popup/App.tsx` — the `ready` state now polls `GET_JOB_PAGE_DATA` for the active tab;
        once present, runs `/extract-job` → `/tailor-resume` + `/answer-questions` in parallel,
        then shows an editable review (job title/company, one textarea per drafted answer). "Fill
        form" builds a `values` map (profile scalars for name/email/phone/location/links fields,
        edited answers for `question` fields), fetches the resume PDF, sends `FILL_FORM`, then
        saves a `draft` application via `POST /applications`. Tested (2 new tests, 5 total)
  - [x] `src/lib/fetchResumePdf.ts` — fetches `/render-resume-pdf` **directly** (not via
        `callBackend`/`sendToBackground`): those always call `res.json()`, which can't parse a
        binary PDF response. Tested (2 tests)
  - Deviation, documented here since it's a real design choice: cover-letter fields
    (`cover_letter_text`/`cover_letter_upload`) are detected but not yet filled — `answerQuestions`
    is only wired to `question`-category fields, matching `docs/architecture-plan.md`'s original
    scope. Extending it to cover letters is future work, not an oversight.
  - Not done: no loading/error UI for a failed extract/tailor/answer/fill call (the popup just
    hangs) — worth hardening before this is used against a real ATS site
- [x] **Application pipeline extraction** (2026-08-07, via
      `/mattpocock-skills:improve-codebase-architecture` → grilling → `/tdd`): pulled the
      extract→tailor→answer→fill→save orchestration out of `popup/App.tsx` into
      `popup/pipeline.ts` — `analyzeJobPage()` (the Analysis Step) and `fillAndSubmit()` (the Fill
      Step), each taking a `PipelineDeps` object so they're testable with fake deps, no `chrome`/DOM
      mocking. `App.tsx` is now a thin caller holding `Status`. Also fixes the "no loading/error
      UI" gap noted above: both functions reject with typed errors (`AnalysisFailedError`,
      `FillFailedError`); `Status` gained `'analyze-error'`/`'fill-error'`, each rendering a "Try
      again" that re-invokes the same phase (idempotent — safe to redo, save is always last).
      Tested (5 new tests in `pipeline.test.ts`); `App.test.tsx` now mocks the `pipeline` module
      directly and only asserts status→render wiring (7 tests, down from 5 broader ones, replaced
      not layered). Domain terms **Application Pipeline**/**Analysis Step**/**Fill Step** captured
      in the repo's first `CONTEXT.md`.
- [x] **Shared message protocol** (2026-08-07, via `/mattpocock-skills:improve-codebase-architecture`
      → grilling → `/tdd`): new `lib/messages.ts` is the single source of truth for every
      `chrome.runtime` message shape (`ReportJobPageMessage`, `GetJobPageDataMessage`,
      `FillFormRequestMessage`/`FillFormCommandMessage` — split into two types because FILL_FORM
      has different shapes popup→background (`tabId`) vs background→content, sharing a
      `FillFormPayload` base) plus a typed `sendMessage<TReq, TRes>()` helper, replacing three
      independently hand-rolled `new Promise((resolve) => chrome.runtime.sendMessage(...))`
      wrappers. Also caught and fixed a second instance of the same duplication:
      `JobPageData` was independently redeclared in `jobPageStore.ts`, `pipeline.ts`, and
      `App.tsx` — now defined once in `messages.ts`. `background/index.ts`, `content/index.ts`,
      `pipeline.ts`, and `App.tsx` all import from it instead of redeclaring locally.
      `sendMessage` tested (1 test, mirrors `sendToBackground.test.ts`'s pattern); the five
      call-site migrations are type-safety-only with no behavior change, verified by the existing
      suites staying green untouched.
- [x] **Split `background/index.ts`'s dispatcher** (2026-08-07, via grilling → `/tdd`):
      `background/relay.ts` (`handleRelayMessage` — the untyped `{path,body,method}` relay,
      unchanged behavior) and `background/router.ts` (`handleTypedMessage` — the
      `REPORT_JOB_PAGE`/`GET_JOB_PAGE_DATA`/`FILL_FORM` switch) replace the single dispatcher that
      used to share one `onMessage` listener for both; `background/index.ts` is now ~10 lines
      composing the two. `background/index.test.ts`'s six cases moved to `relay.test.ts`
      (3 tests, calling `handleRelayMessage` directly, no `chrome` mocking) and `router.test.ts`
      (3 tests, calling `handleTypedMessage` directly) — replaced, not layered. `index.ts` itself
      has no dedicated test, same as `manifest.ts`.
- [x] **Selector resolution deduped into `fillForm.ts`** (2026-08-07, via grilling → `/tdd`):
      `content/fillForm.ts` exports `resolveField<T extends Element = HTMLElement>(doc, field)`,
      used internally by `fillForm()` and by `content/index.ts`'s resume-attach path (which
      previously re-implemented the same `querySelector` lookup independently). Tested directly
      (2 new tests in `fillForm.test.ts`); `fillForm()`'s and `content/index.ts`'s existing tests
      stayed green unmodified, confirming the refactor didn't change behavior.
- [x] **Job-description paste fallback** (2026-08-10, via `/tdd`): some ATS embeds split a posting
      into Overview/Application tabs, and it's unconfirmed whether the Overview tab's DOM content
      survives a client-side tab switch (may be unmounted, not just hidden) — if it doesn't,
      `scrapePageText`'s single DOM snapshot at detection time can miss the job description
      entirely, since detection fires once the Application tab's form is visible. Rather than guess
      at ATS-specific tab markup, `popup/App.tsx`'s review screen gained an "Edit job description"
      toggle revealing a textarea (pre-filled with the scraped `pageText`) and a "Re-analyze"
      button; re-analysis re-runs `analyzeJobPage` with the edited text substituted in, everything
      else (fields, tabId, etc.) unchanged. Manual/universal fallback — works regardless of which
      platform or failure mode caused a bad scrape, not just the tabbed-Ashby case that prompted it.
      Tested (2 new tests in `App.test.tsx`, 11 total).
- [x] **Paste fallback moved before first analysis, not just after** (2026-08-10, via `/tdd`):
      `status: 'ready'` no longer auto-transitions straight to `'analyzing'` once a job page is
      detected — it now shows a "Ready to analyze" screen with the scraped `pageText` in an
      always-visible (not toggled) textarea and an explicit "Analyze" button, so a bad scrape can
      be corrected before the first LLM call, not only after seeing a bad result. The `'review'`
      screen's toggled "Edit job description"/"Re-analyze" editor (previous entry) is unchanged and
      still there for after-the-fact correction. Both share the same `pageTextOverride` state.
      Existing tests updated (a `clickAnalyze()` helper added, since analysis no longer starts on
      its own); 2 new tests. `App.test.tsx`: 13 total (up from 11).
- [x] **Paste + Analyze decoupled from job-page detection entirely** (2026-08-10, via `/tdd`):
      the `'ready'` screen now always shows the paste box + "Analyze" button immediately, whether
      or not a job page has been auto-detected yet — the `'not-detected'` status/dead-end and its
      "Try again" retry are gone; detection is now purely a background pre-fill (populates the
      textarea + `fields` when it succeeds) rather than something that gates the UI. Clicking
      "Analyze" with no job page ever detected synthesizes `{ pageText, fields: [] }` so analysis
      (job info + tailored resume + drafted answers) still works standalone from pasted text alone
      — "Fill form" just has nothing to act on until a real form is detected, which is an accepted
      trade-off of the manual-first flow. "Analyze"/"Re-analyze" are disabled whenever there's no
      text to send (pasted or scraped) — needed a `??` vs `||` fix along the way: the effective
      text used for the textarea's *display* value, the disabled check, and the analyze payload
      must all read from the exact same `pageTextOverride ?? jobPageData?.pageText ?? ''`
      expression, or clearing the box either fights the user's typing (silently reverts) or lets a
      blank submission slip through depending on which operator is used where. `App.test.tsx`: 14
      total (up from 13) — replaced the not-detected/retry tests, added paste-without-detection and
      the disabled-on-empty cases for both editors.

### Phase 7 — Application tracking data model (planned 2026-08-07, not started)

New scope: track interview progress per application (stage) and keep a running, categorized notes
log (e.g. "what technical questions were asked", "what behavioral questions were asked") so past
interviews are useful reference material later.

- [ ] `packages/shared`: add `ApplicationStageSchema` — `'applied' | 'phone_screen' |
      'interviewing' | 'offer' | 'rejected' | 'withdrawn'`. Kept separate from the existing
      `status: 'draft' | 'submitted'` (status = "was this actually sent"; stage = "where it is in
      the interview pipeline post-submission")
- [ ] `packages/shared`: add `NoteSchema` — `{ id, category: 'technical_questions' |
      'behavioral_questions' | 'general', text, createdAt }`; add `notes: Note[]` (defaults `[]`)
      and `stage: ApplicationStage` (defaults `'applied'`) to `ApplicationSchema`/`NewApplicationSchema`
- [ ] `applicationsRepository.ts`: add `updateApplicationStage(id, stage)` and
      `addApplicationNote(id, note)`
- [ ] `PATCH /applications/:id/stage` route — body `{ stage }`
- [ ] `POST /applications/:id/notes` route — body `{ category, text }`, server generates
      `id`/`createdAt`
- [ ] Migration for the new `stage`/`notes` columns on `applications`
- Build test-first per the established process, same as Phases 3/4

### Phase 8 — Frontend dashboard (planned 2026-08-07, not started)

New scope: a local web app to browse past applications, see which resume/answers went to which
job, and track/update interview stage + notes. Depends on Phase 7's stage/notes routes.

- [ ] `apps/dashboard` — separate Vite + React app (own dev server, e.g. `localhost:5173`),
      **not** part of the extension — talks to the same backend on `127.0.0.1:5391`
- [ ] Backend needs CORS middleware added (`hono/cors`) — currently none exists, and the dashboard
      is a different origin than the backend
- [ ] Applications list view — table of company / role / stage (badge) / date, filterable by stage
- [ ] Application detail view — job info, tailored resume, drafted answers, notes log (filterable
      by category), stage selector, add-note form
- [ ] No LLM calls from the dashboard itself — pure read/write against existing + Phase 7 endpoints

### Phase 9 — Company-culture-aware answers (planned 2026-08-07, not started)

New scope: before drafting Question Answers, optionally research the company's own site (about/
careers/values pages) and feed that into the answer-drafting prompt so freeform answers (e.g. "why
do you want to work here") reflect the company's actual stated culture instead of generic
tailoring. Runs as an extra step inside the existing Analysis Step, not a new always-on background
process — decided with the user:

- Source is the **company's own website only** (about/careers/values pages), not third-party
  review sites (Glassdoor/LinkedIn) — cheaper, no scraping-ToS gray area, and matches this
  project's existing pattern of only using first-party sources (the job posting itself).
- **User confirmation required before it runs** — this step does an extra site fetch + LLM call
  the user might not want on every job page, so the popup must ask (e.g. a "Research company
  culture?" prompt/button) before kicking it off, rather than running it silently every time like
  the rest of the Analysis Step.
- Drafted answers stay subject to the existing rule: **always reviewed/edited by the user before
  the Fill Step** — this phase does not introduce any new auto-fill/auto-submit path.

- [ ] `packages/shared`: add `CompanyCultureSchema` — structured culture signals (e.g. values,
      mission, work-style keywords) extracted from a company's site, plus the raw source URL(s)
      used
- [ ] `apps/backend/src/llm/researchCompanyCulture.ts` — scrapes the company's about/careers/values
      page(s) and extracts `CompanyCulture` via an LLM call (Haiku, same cost class as
      `extractJob`); tested like the other LLM-layer modules (Phase 3 pattern)
- [ ] `POST /research-culture` route — body `{ companyUrl }` (or company name, if a lookup step is
      needed to find the site first), zod-validated, returns `CompanyCulture`
- [ ] `answerQuestions` gains an optional `companyCulture` param; when present, the prompt
      incorporates it so drafted answers align with the company's stated culture — never fabricates
      alignment the Profile doesn't support, same non-fabrication rule as `tailorResume`
- [ ] Popup: add a confirmation prompt ("Research company culture?") before this step runs; on
      confirm, calls `/research-culture` then re-runs answer drafting with the result; drafted
      answers still land in the existing editable review UI before the Fill Step, unchanged
- [ ] Extend `CONTEXT.md`'s Language section with **Company Culture** once the shape is settled
- Build test-first per the established process, same as Phases 3/4/7

### Phase 10 — Live chat to refine drafted answers (planned 2026-08-10, not started)

New scope: in the popup's review UI, let the user open a chat with the AI *about a specific
drafted answer* and iterate on it conversationally ("make this shorter", "lead with the
migration story instead", "sound less formal") instead of only hand-editing the textarea. Scoped
to `question`-category fields only (the freeform drafted answers already in the review UI) — not
select/combobox/radiogroup fields, which are constrained-choice and not a good fit for freeform
rewriting. Manual textarea editing stays as-is; this is an additive alternative, not a replacement.

Note on numbering: **Phase 9 is already taken** (company-culture-aware answers, planned
2026-08-07, not started) — this is filed as Phase 10 rather than renumbering existing phases.
Reorder if this should actually take priority over Phase 9.

Open design question, not yet decided with the user: Chrome extension **popups are destroyed and
rebuilt from scratch every time they close** (unlike a persistent surface), so any in-progress chat
history kept only in the popup's React state is lost if the user clicks away mid-conversation. Two
ways to handle this, needing a decision before implementation starts:
- Accept the limitation for v1 (chat is scoped to a single popup-open session; closing the popup
  resets it) — simplest, no architecture change.
- Move the review UI (or just the chat) into a `chrome.sidePanel` (MV3 API), which stays open
  independent of navigation/clicks — bigger change, but matches what "live chat" implies.

- [ ] `packages/shared`: add `ChatMessageSchema` (`role: 'user' | 'assistant'`, `content`) and a
      request/response shape for one chat turn (profile, jobInfo, question, current answer, prior
      `messages: ChatMessage[]` → assistant reply, plus an optional `revisedAnswer` string when the
      assistant's reply represents a concrete new draft rather than just conversation)
- [ ] `apps/backend/src/llm/chatAboutAnswer.ts` — one turn of the conversation; same model tier as
      `answerQuestions` (`MODELS.writing`, Sonnet), grounded in `profile`/`jobInfo` with the same
      non-fabrication rule as the rest of the answer-drafting prompts. Tested like the other
      LLM-layer modules (Phase 3 pattern)
- [ ] `POST /chat-answer` route — zod-validated body, returns `{ reply, revisedAnswer? }`
- [ ] Popup: a "Refine with AI" affordance per question card opening a small message-thread UI
      (history + input); when a reply includes `revisedAnswer`, a "Use this" action applies it to
      the existing answer textarea (still editable by hand afterward, same as today)
- [ ] Decide + document the popup-teardown question above before writing the chat-history state
      management
- Build test-first per the established process, same as Phases 3/4/7/9

## Open architecture-review recommendations

From two `/mattpocock-skills:improve-codebase-architecture` runs — 2026-08-07 (backend-focused,
report not saved) and a second 2026-08-07 pass (extension-focused, after Phase 6 landed). Not yet
decided/actioned:

- [ ] **Worth exploring:** `profileRepository.saveProfile`'s upsert logic has zero test coverage
      (the route test mocks the whole repository away) — test it directly
- [ ] **Worth exploring:** unify request-body validation across routes — `profile.ts` uses zod,
      `extract-job.ts` uses a bare truthiness check with no runtime type guarantee
- [ ] **Speculative:** `tailorResume.ts` / `answerQuestions.ts` both hand-build the same
      `<base_profile>`/`<job_info>` prompt scaffold — extract a shared helper if a third
      writing-model call site appears

**Done:** all three **Strong** candidates from both runs are actioned — extracting
`popup/App.tsx`'s orchestration into `popup/pipeline.ts` and giving the message protocol a shared
module (`lib/messages.ts`), both under Phase 6 above; and deriving the LLM `input_schema` from
zod, under Phase 3 above. Both **Worth exploring** extension candidates are also actioned (2026-08-07,
via grilling → `/tdd`), under Phase 6 above: `background/index.ts` split into `relay.ts`
(`handleRelayMessage`, thin, unchanged) + `router.ts` (`handleTypedMessage`, owns
`REPORT_JOB_PAGE`/`GET_JOB_PAGE_DATA`/`FILL_FORM`), with `index.ts` reduced to composing the two —
`background/index.test.ts` replaced by `relay.test.ts`/`router.test.ts` testing each function
directly; and `content/fillForm.ts` gained `resolveField<T>(doc, field)`, used by both `fillForm()`
and `content/index.ts`'s resume-attach path (which previously re-implemented the same lookup).
What's left below is all backend, all lower-conviction (**Worth exploring**/**Speculative**).

## Known loose ends / notes

- The `/code-review` background agent run on 2026-08-07 terminated itself immediately with "no
  findings" — looked anomalous, never actually reviewed anything. Worth re-running.
- `apps/backend/README.md` says routes/app.ts are "not built yet" — that's now stale (they exist);
  update it next time you're in that file.
- `pnpm --filter backend build` (`tsc -p tsconfig.json`) fails — there's no `tsconfig.json` in
  `apps/backend` at all (only `packages/shared` has one). Pre-existing, not caused by the route
  work above; needs fixing before a real build/deploy is possible.
