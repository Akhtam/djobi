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
  Current branch: `phase_4`.
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
      job-specific), summary/skills/work-experience from `tailoredResume`. Tested (1 test, asserts
      real `%PDF-` output — no mocking, since there's no LLM/network involved)
- [x] `POST /render-resume-pdf` route — tested (2 tests), zod-validates `{ profile,
      tailoredResume }`, returns raw PDF bytes with `content-type: application/pdf`
- Note: no `tsconfig.json` in `apps/backend` (see Known loose ends) means JSX in
  `renderResume.tsx` uses the classic transform by default — needed an explicit `import React from
  'react'` for `React.createElement` to resolve at runtime; switch to the automatic runtime once a
  tsconfig exists.

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
      `ProfileSchema` field: scalar fields (name/email/phone/location/summary/links), plus
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

### Phase 6 — Content scripts

- [ ] Not started: ATS host detection, page scraping, generic field-classifier, DataTransfer-based
      resume file upload, form fill

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

## Open architecture-review recommendations

From the `/mattpocock-skills:improve-codebase-architecture` review run 2026-08-07
(report was a temp HTML file, not saved — rerun the skill if you want it again). Not yet decided/
actioned:

- [ ] **Strong:** derive the LLM tool `input_schema` from the zod `schema` inside `callStructured`
      itself, instead of hand-maintaining a parallel JSON Schema in `extractJob.ts` /
      `tailorResume.ts` / `answerQuestions.ts` (currently duplicated 3×, drifts silently)
- [ ] **Worth exploring:** `profileRepository.saveProfile`'s upsert logic has zero test coverage
      (the route test mocks the whole repository away) — test it directly
- [ ] **Worth exploring:** unify request-body validation across routes — `profile.ts` uses zod,
      `extract-job.ts` uses a bare truthiness check with no runtime type guarantee
- [ ] **Speculative:** `tailorResume.ts` / `answerQuestions.ts` both hand-build the same
      `<base_profile>`/`<job_info>` prompt scaffold — extract a shared helper if a third
      writing-model call site appears

## Known loose ends / notes

- The `/code-review` background agent run on 2026-08-07 terminated itself immediately with "no
  findings" — looked anomalous, never actually reviewed anything. Worth re-running.
- `apps/backend/README.md` says routes/app.ts are "not built yet" — that's now stale (they exist);
  update it next time you're in that file.
- `pnpm --filter backend build` (`tsc -p tsconfig.json`) fails — there's no `tsconfig.json` in
  `apps/backend` at all (only `packages/shared` has one). Pre-existing, not caused by the route
  work above; needs fixing before a real build/deploy is possible.
