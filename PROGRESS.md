# djobi — Progress

**What this is:** a Chrome extension that autofills job applications on ATS sites (Greenhouse,
Ashby, Lever, Workday, ...) with an AI-tailored resume and drafted answers to freeform questions.
Full architecture/design plan: `docs/architecture-plan.md` (in git — summarized below).

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
  `apps/extension` (MV3, Vite + `@crxjs/vite-plugin` + React). GitHub remote: `Akhtam/djobi`.
  Current branch: `setup_routes`.

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

### Phase 4 — Profile + applications persistence

- [x] `GET /profile` / `POST /profile` — tested (4 tests), backed by `db/profileRepository.ts`
- [ ] `GET /applications`, `GET /applications/:id` — not built
- [ ] Writing an `applications` row after a fill completes — not built
- [ ] `tailorResume`'s `priorApplicationsSummary` param exists but nothing calls it yet (needs a
      query for past applications to the same company)

### Phase 5 — Chrome extension

- [x] `apps/extension` scaffold: `package.json`, `tsconfig.json`, `vite.config.ts`, MV3
      `src/manifest.ts` (host permissions for the local backend + ATS content-script matches,
      background service worker, popup/options pages), builds clean via `pnpm --filter extension
      build` — infra, not TDD'd
- [x] `src/background/callBackend.ts` — posts JSON to the local backend
      (`http://127.0.0.1:5391<path>`), resolves with the parsed response, rejects with the
      backend's `{ error }` message on a non-ok response; tested (2 tests)
- [ ] Wire `callBackend` into `src/background/index.ts` as a `chrome.runtime.onMessage` relay
      (currently an empty stub)
- [ ] Popup UI (`src/popup/App.tsx` is a placeholder — review/edit UI not built)
- [ ] Options page UI (`src/options/App.tsx` is a placeholder — profile onboarding form not built)
- [ ] No extension icons yet (manifest omits `icons` to keep the build from failing on missing
      files)

### Phase 6 — Content scripts

- [ ] Not started: ATS host detection, page scraping, generic field-classifier, DataTransfer-based
      resume file upload, form fill

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
