# djobi — Progress

**What this is:** a Chrome extension that autofills job applications on ATS sites (Greenhouse,
Ashby, Lever, Workday, ...) with an AI-tailored resume and drafted answers to freeform questions —
plus a local dashboard for tracking which resume/answers went to which job, interview stage, and
notes (Phases 7-8, added 2026-08-07).

Domain vocabulary is in `CONTEXT.md`; per-package detail is in `README.md`, `apps/backend/README.md`
and `packages/shared/README.md`. (`docs/architecture-plan.md`, the original design plan, was deleted
2026-08-12 — it had been overtaken on nearly every point and is in git history.)

**Read this file at the start of a new session** to pick up where the last one left off. Update it
as work happens — check items off, add new ones, don't let it go stale.

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
- **Job Description is pasted, never scraped.** The application form is a different page from the
  job ad, so scraping captured form labels and nav bars instead of the posting. Removed 2026-08-12.
- **Review surface is a side panel, not a popup.** A popup is destroyed on any outside click; the
  panel survives tab switches, and the pipeline runs in the service worker so closing the panel
  mid-run doesn't drop the result.
- **Process:** this project is being built test-first (red → green, one vertical slice at a time)
  — see the `mattpocock-skills:tdd` skill. Continue that pattern for new routes/modules.
- **Repo:** pnpm workspace, `packages/shared` (zod schemas) + `apps/backend` (Hono) +
  `apps/extension` (MV3, Vite + `@crxjs/vite-plugin` + React) + `apps/dashboard` (planned, Phase 8:
  separate Vite + React web app, not part of the extension). GitHub remote: `Akhtam/djobi`.
  Current branch: `dash`.
- **Application tracking (Phase 7-8):** `status` (draft/submitted) and `stage` (applied →
  phone_screen → interviewing → offer/rejected/withdrawn) are separate fields. Notes are a
  timestamped, categorized log (`technical_questions` / `behavioral_questions` / `general`) you
  append to, not a single overwritable text field — so old interview-question notes stay around as
  reference for future applications.

## Checklist

### Phases 1-6 — complete (2026-08-07 → 2026-08-12)

The workspace, backend, and extension are built and green end-to-end. Summary of what each phase
delivered, in terms of the modules that exist today — the blow-by-blow build log lived here until
2026-08-12 and is in git history if you need it.

- **Phase 1 — workspace.** pnpm workspace; `packages/shared` with the zod schemas both apps import;
  Prettier at the root (single quotes).
- **Phase 2 — backend skeleton.** Drizzle schema (`profiles`, `applications`), lazily-initialized
  Neon client, `app.ts` (testable Hono instance) separate from `index.ts` (the entrypoint, bound to
  `127.0.0.1:5391`). Real Neon project created and migrated (`0000_slimy_manta.sql`).
- **Phase 3 — LLM layer + routes.** `extractJob` (Haiku), `tailorResume` / `answerQuestions`
  (Sonnet), all through `structuredCall.ts`; `pdf/renderResume.tsx`; the five LLM/PDF routes.
- **Phase 4 — persistence.** `GET`/`POST /profile`, `GET`/`POST /applications`,
  `GET /applications/:id`, backed by the two repositories. `/tailor-resume` computes
  `priorApplicationsSummary` server-side from past applications to the same company; the route
  deliberately does not accept a client-supplied one.
- **Phase 5 — extension scaffold.** MV3 manifest, Vite + `@crxjs/vite-plugin`, the options page
  (full Profile editor), and `lib/callBackend.ts` as the single transport to the local backend from
  every extension context.
- **Phase 6 — content scripts and the end-to-end flow.** `content/detect.ts` (a page-shape heuristic
  plus an arming-window `MutationObserver`), `content/detectFields.ts` (the field classifier),
  `content/fillForm.ts` (the filler), `background/applicationPipeline.ts` (the Analysis and Fill
  Steps), `lib/tabStore.ts` (per-tab state in `chrome.storage.session`), and the side panel.

**Decisions from those phases that are still load-bearing**, and are recorded nowhere else:

- `attachResumeFile` keeps a non-`DataTransfer` fallback branch (shadowing `.files` via
  `Object.defineProperty`) purely because **jsdom has no `DataTransfer` constructor** and no public
  `FileList` constructor either. Production takes the real `DataTransfer` path. This is a test
  environment constraint living in product code — don't "simplify" it away.
- **Cover-letter fields (`cover_letter_text` / `cover_letter_upload`) are detected but deliberately
  not filled.** `answerQuestions` is wired only to `question`-category fields. A scope decision,
  not an oversight.
- **The `??` vs `||` trap on the job-description box.** The textarea's display value, the
  Analyze-button disabled check, and the analyze payload must all read the _same_ expression.
  Use different operators in different places and the box either silently reverts the user's typing
  or lets a blank submission through.
- `pdf/renderResume.tsx` needs an explicit `import React from 'react'` — without a
  `tsconfig.json` in `apps/backend`, JSX uses the classic transform and `React.createElement` must
  resolve at runtime. Switch to the automatic runtime once a tsconfig exists.
- A test profile (`Jane Doe`) is sitting in the real `profiles` table from an early smoke test.
  Harmless — it gets overwritten by the real profile — but worth knowing it's there.

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

New scope: in the side panel's review UI, let the user open a chat with the AI _about a specific
drafted answer_ and iterate on it conversationally ("make this shorter", "lead with the
migration story instead", "sound less formal") instead of only hand-editing the textarea. Scoped
to `question`-category fields only (the freeform drafted answers already in the review UI) — not
select/combobox/radiogroup fields, which are constrained-choice and not a good fit for freeform
rewriting. Manual textarea editing stays as-is; this is an additive alternative, not a replacement.

Note on numbering: **Phase 9 is already taken** (company-culture-aware answers, planned
2026-08-07, not started) — this is filed as Phase 10 rather than renumbering existing phases.
Reorder if this should actually take priority over Phase 9.

**Resolved 2026-08-12:** this phase's open design question was whether to accept chat history being
destroyed on every popup close, or move the review UI into a `chrome.sidePanel`. The side panel was
built for unrelated reasons (the popup lost in-flight runs on any outside click), so the harder
option is already taken and this phase inherits a persistent surface. What's left to decide is only
whether chat history should survive a _panel reopen_ — i.e. whether it belongs on
`PipelineRunState` in `lib/tabStore.ts` alongside the answers, or stays React-local.

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

### Fill fidelity + dropping the page scrape (2026-08-12)

- [x] `content/fillForm.ts` — a fill now drives the event sequence a real keystroke produces
      (`focus` → `InputEvent('input')` → `change` → `blur`/`focusout`), not just a value write plus
      `input`. Form libraries layered over React commonly commit a field's value to the _form_
      model on blur, so a fill that never blurred left the DOM looking right and the model empty —
      which is what an ATS reports on submit as "missing entry for required field" over a visibly
      filled form.
- [x] `content/fillForm.ts` — `fillForm` returns the ids it can **verify** still hold their value,
      checked after a 300ms settle (a controlled field whose `onChange` never fired reverts on the
      _next_ render, so an immediate re-read calls every failed fill a success). Per-widget checks:
      `value` for text/select, `checked`/`aria-checked`/`aria-pressed` for groups, trigger text for
      comboboxes.
- [x] `FILL_FORM` now replies `{ ok, filledFieldIds, resumeAttached }`, and `applicationPipeline`'s
      `unresolvedRequiredFields`/`filledFieldCount` come from that reply rather than from the values
      it _sent_. A fill the page discarded is now reported instead of showing a green check. A
      `null` reply (no content script — tab open across an extension reload) still falls back to the
      drafted values, since "no account" isn't "nothing filled".
- [x] **Page-text scraping removed entirely.** `content/scrapeJob.ts` is deleted, `JobPageData` is
      `{ fields }`, and the pasted job description is the Analysis Step's only input
      (`StartAnalysisMessage.jobDescription`, `PipelineRunState.jobDescription`). The application
      form is a different page from the job ad, so the scrape routinely captured the form's own
      labels and a nav bar instead of the posting — and on a client-rendered ATS, whatever happened
      to have mounted. Detection stays: the Fill Step still needs to know what to fill.
- [x] Backend renamed to match: `POST /extract-job` takes `{ jobDescription }` (was `{ pageText }`)
      and `extractJob`'s prompt no longer tells the model it is reading scraped page text — told
      that, it tolerates and mines the junk a scrape carries.

### Resume PDF design pass (2026-08-12)

- [x] `docs/resume-design-conventions.md` — research against primary sources (Butterick, Harvard OCS,
      MIT CAPD, Stanford, Greenhouse/Workday/Taleo parsing docs) on margins, sizes, leading, line
      length, type scale, section order, and what breaks ATS parsing. Names the conflicts rather
      than smoothing them: Butterick's 45–90 cpl is unreachable single-column on A4, and the
      "fill 85–90% of the page" heuristic is **folklore** — no primary source states it, and
      Butterick argues the opposite ("uncomfortably dense with text").
- [x] `pdf/renderResume.tsx` — restyled to those values. Hierarchy now comes from weight, case,
      tracking and a hairline rule rather than size (section headings are 1.05× body, not 1.2×).
      Fixed two sourced floors the file sat under: `padding: 32` (0.44") was below MIT's 0.5"
      minimum, and no `lineHeight` left react-pdf's ~1.15 default under Butterick's 120%.
- [x] `renderResume.test.ts` — reads the rendered text back with `unpdf` so a layout regression can
      actually fail a test.
- [x] `pdf/renderResume.tsx` — the render now **fits itself to one page**: it renders at the
      researched density, counts pages (`pageCount`, read off the PDF's own page tree), and
      re-renders one step tighter down a four-step ladder until it fits. Every step is inside a
      sourced range, and no step touches `fontSize` — leading and whitespace are spendable,
      legibility is not. Fits up to ~5 roles × 6 bullets; beyond that it returns two pages with all
      content rather than truncating, since silently dropping the candidate's experience is the
      worse failure. Common case still costs exactly one render.
- Page fill went 65.5% → 86.3% on the current profile (14 bullets / 3 roles), inside every sourced
  floor. **It is tuned to that content**: 1.4 lines of slack remain before it spills to page 2, and
  the research's own budget says ~50 line-equivalents (3 roles × 7–8 bullets) is what honestly
  fills a page. Real fix for a thin resume is upstream in `tailorResume.ts`, not in the stylesheet.

## Open architecture-review recommendations

Every **Strong** candidate from the two 2026-08-07 runs was actioned under Phases 3 and 6. What
follows is what's still open, newest run first.

### From the 2026-08-12 run

- [x] **Done — candidates 1-4, 2026-08-12.** Four of the run's seven, including the one live bug.
      Full suite green at 347 tests (82 shared / 41 backend / 224 extension).

  - **The wire contract is one artifact.** New `packages/shared/src/wire.ts` owns the request schema
    for every Application Pipeline route; the six routes parse with it instead of restating the
    domain inline, and `lib/backendClient.ts` builds each body against the same schema via
    `satisfies`, so a drift between what the extension sends and what the backend accepts is now a
    compile error. **This fixed a live bug**: `/answer-questions` had been silently stripping
    `knownAnswer` (zod `.object()` drops unknown keys), so the prompt paragraph treating a
    sponsorship or work-authorization answer as binding fact had never once run in production. The
    regression test was confirmed red against the old schema before the fix landed.
  - **`PipelineDeps` is two collaborators, not seven methods** — `{ backend: BackendClient; page:
PageClient }`. New `lib/pageClient.ts` owns both `chrome.tabs.sendMessage` round-trips and now
    has its own test: the `lastError` handshake and the `ArrayBuffer → number[]` encoding were
    previously reachable only by running a whole pipeline step.
  - **The coordination protocol is notification-only.** `sendMessage<TReq, TRes>` is now
    `notify(message): void` (and reads `lastError`, which nothing did before); `handleTypedMessage`
    no longer takes a `sendResponse` it never called or returns a `boolean` that was always `false`.
    The two messages that genuinely have responses live in `PageClient`.
  - **The label-matching rules have names.** New `packages/shared/src/labelMatching.ts` (replacing
    `optionLabel.ts`) holds all of them with a table saying which to use when, and the ambiguity
    invariant — _more than one candidate means no match_ — is implemented once in `uniqueMatch`
    rather than re-derived at three sites. `apiDetectors` now warns when an oracle answered but
    matched no field by label, which used to be indistinguishable from no oracle running at all.
    **Found and fixed a second real bug while naming the rules**: containment matching kept trailing
    punctuation, so a stored custom answer for "Are you willing to relocate?" could never match a
    form's "Are you willing to relocate for this role?" — the "?" lands mid-phrase. That is the
    exact case the feature exists for, and it had never worked.

- [x] **Done — candidates 5-7, 2026-08-12.** The run is fully actioned. Suite green at 370 tests
      (93 shared / 41 backend / 236 extension).

  - **Detected Field is a module.** New `packages/shared/src/detectedField.ts` owns the schema plus
    the rules that were documented in six separate files — id stability, a choice group being one
    field, a nullable option `selector`, and "an ambiguous match is no match" — as `optionFor` and
    `matchAnswerToField`. `parseDetectedFields` is now applied at the two boundaries that actually
    skew and previously parsed nothing: `tabStore.read`, where `chrome.storage.session` outlives an
    extension reload and can hold a field written by an older build, and the router's
    `REPORT_JOB_PAGE`, where an orphaned content script keeps reporting the shape it knows. Schema
    defaults mean an older field parses rather than being dropped; a field that genuinely no longer
    fits costs that field, not the form.
  - **The panel's status has one owner.** `usePipelineRun` returns the _effective_ status and takes
    the optimistic request as `begin(status)`, so `syncedAt` — a counter exported purely so one
    `useEffect` could stand an optimistic status down — is gone from the interface entirely. New
    `panel/useActiveTab.ts` holds the four `chrome.tabs` touchpoints behind one seam and reports a
    `changeToken` that covers same-tab navigation, which a tab id alone cannot.
  - **The options page is 626 lines, down from 780.** `EMPTY_PROFILE` and a new `parseProfile` live
    in `@djobi/shared` beside the schema they mirror, replacing the hand-maintained fourth copy of
    the Profile shape. `parseProfile` also merges `links`, which the old top-level spread could not
    reach — a Profile saved before `github` was added to `links` kept a `links` with no `github` key
    and the default never applied. The four list editors now share one `ListSection` and a
    `listEditor(profile, setProfile, key, blank)`, replacing ~20 inline
    `setProfile({ ...profile, xs: … })` closures including one nested three levels deep. All 16
    existing options tests passed unmodified, which is the evidence the behaviour is unchanged.

Still open from that run — nothing. Noted while in there, not actioned:

- [ ] Every new Story is created with `id: ''`, but `QuestionAnswer.sourceStoryIds` references
      `Story.id` — so those references are useless whenever the candidate didn't type an id by hand.
      A behaviour change rather than a refactor, hence left alone; see `options/App.tsx`.

### Still open from 2026-08-07

- [ ] **Worth exploring:** `profileRepository.saveProfile`'s upsert logic has zero test coverage
      (the route test mocks the whole repository away) — test it directly. Related:
      `applicationsRepository.toApplication` casts jsonb straight to typed fields while
      `profileRepository.getProfile` deliberately parses — two policies for the same hazard.
- [ ] **Worth exploring:** unify request-body validation across routes — `profile.ts` uses zod,
      `extract-job.ts` uses a bare truthiness check with no runtime type guarantee. Folded into the
      shared-wire-contract item above.
- [ ] **Speculative:** `tailorResume.ts` / `answerQuestions.ts` both hand-build the same
      `<base_profile>`/`<job_info>` prompt scaffold — extract a shared helper if a third
      writing-model call site appears.
- [ ] **Speculative:** `options/App.tsx` is a 780-line leaf whose four list editors are hand-written
      variants of one shape. The cheap half is worth doing on its own: replace the hand-maintained
      `EMPTY_PROFILE` and its spread with `ProfileSchema.parse(loaded ?? {})`, since the schema
      already owns the defaults and the spread is where the missing-key defect class lives.

## Known loose ends / notes

- `pnpm --filter backend build` (`tsc -p tsconfig.json`) fails — there's no `tsconfig.json` in
  `apps/backend` at all (only `packages/shared` has one). Needs fixing before a real build/deploy is
  possible, and it's what forces the classic JSX transform in `renderResume.tsx`.
- **The Ashby API oracle is dead code.** `background/apiDetectors.ts` calls an endpoint that returns
  401 and has never enriched a field; the working unauthenticated GraphQL endpoint, the query, and
  the response shape are all written up in that file's own doc comment. Needs a
  `host_permissions` addition too.
- **`packages/shared/src/screeningAnswers.ts` has no test file** — the only module in that package
  without one, and it holds `resolveAnswerOption`, whose uniqueness rule is what stands between a
  stored prepared answer and the wrong box on a legal declaration.
- Two Ashby questions still need a live browser check, carried over from the (now deleted)
  fill-failure investigation: whether `data-djobi-id` attributes survive an Ashby form re-mount
  (if not, `resolveField` returns null for every field), and how Ashby renders its four Boolean
  screening questions — native fieldset/radios and `role="combobox"` are handled, custom buttons
  are not.
