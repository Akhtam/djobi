# djobi — Job Application Autofill Chrome Extension

## Context

When applying to jobs via LinkedIn, applicants get redirected to third-party ATS platforms (Greenhouse, Ashby, Lever, Workday, etc.) where they must re-fill the same contact/resume fields and often re-answer freeform questions ("Why do you want to work here?") by hand, using the same static resume regardless of the specific role.

The goal is a Chrome extension that, on landing on one of these ATS pages, offers to autofill the application using a locally-stored profile, generate a resume tailored to that specific job posting, and draft answers to any freeform questions — all reviewable/editable before submission.

Decisions made with the user:

- **Resume generation**: AI-tailored per job, not a static file.
- **Backend**: a local-only Node/Hono server (no hosting, no auth, no multi-device sync for v1).
- **Form filling**: a single generic, heuristic field-matching engine rather than per-ATS selectors — works on any site, not just the two named.
- **Freeform questions**: AI-drafts answers from the profile + job posting; user reviews/edits before submit.
- **Models**: `claude-haiku-4-5` for job-info extraction (cheap, structured, high volume), `claude-sonnet-5` for resume tailoring and question-answer drafting (quality matters more, still far cheaper than Opus).
- **Application history**: every generated resume + answer set is persisted, keyed to the job posting, so past applications can be referenced later (e.g. "what did I say to this company last time"). Storage is **Postgres hosted on Neon** (serverless Postgres, free tier, scales to zero when idle — a good fit since the backend is only active while actively applying to jobs), accessed via **Drizzle ORM**. The Hono backend itself still runs locally on your machine; only the database is cloud-hosted.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐        ┌────────────────────┐
│  Chrome Extension (MV3)     │        │  Local Hono Backend (Node)    │        │  Neon Postgres       │
│                              │        │  http://127.0.0.1:5391        │        │  (cloud, serverless) │
│  content script  ───scrape──┼───────▶│  POST /extract-job  (Haiku)   │        │                      │
│  (job page)       ◀──fill───┼───────▶│  POST /tailor-resume (Sonnet) │───────▶│  profiles            │
│                              │        │  POST /render-resume-pdf      │  Drizzle │  applications      │
│  popup (review UI)          │        │  POST /answer-questions       │   ORM   │  (job info, resume,  │
│  background worker (relay)  │        │  (Sonnet)                     │  (TLS)  │   answers, status)   │
│  options page (profile)     │        │  GET/POST /profile            │        │                      │
└─────────────────────────────┘        │  GET /applications             │        └────────────────────┘
                                        └──────────────────────────────┘
```

One end-to-end flow: content script detects an ATS-shaped page → scrapes job text + form fields → background worker calls the local backend to extract structured job info, tailor the resume, render a PDF, and draft question answers → popup shows an editable review → user confirms → content script fills the DOM and attaches the resume file → the backend writes the job info, tailored resume, and answers to Postgres as one `applications` row, so future tailoring/answer prompts can reference past applications to the same company or similar roles.

## Repo layout (pnpm workspace)

The repo already has `pnpm` pinned in `package.json` (`devEngines.packageManager`), so build on that instead of introducing another tool.

```
djobi/
├── pnpm-workspace.yaml
├── package.json                 (workspace root — add "packageManager", scripts)
├── packages/
│   └── shared/                  (zod schemas + types shared by extension & backend)
│       └── src/schemas.ts       (Profile, JobInfo, TailoredResume, QuestionAnswer)
├── apps/
│   ├── backend/                 (Hono + Node, TypeScript)
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── index.ts         (Hono app, listens on 127.0.0.1:5391)
│   │       ├── routes/
│   │       │   ├── profile.ts
│   │       │   ├── extract-job.ts
│   │       │   ├── tailor-resume.ts
│   │       │   ├── render-resume-pdf.ts
│   │       │   ├── answer-questions.ts
│   │       │   └── applications.ts   (list/get past applications)
│   │       ├── llm/
│   │       │   ├── client.ts        (Anthropic client singleton)
│   │       │   ├── extractJob.ts    (Haiku 4.5 + structured output)
│   │       │   ├── tailorResume.ts  (Sonnet 5)
│   │       │   └── answerQuestions.ts (Sonnet 5)
│   │       ├── pdf/
│   │       │   └── renderResume.tsx  (@react-pdf/renderer template)
│   │       └── db/
│   │           ├── client.ts         (drizzle + node-postgres pool)
│   │           ├── schema.ts         (profiles, applications tables)
│   │           └── migrations/       (drizzle-kit generated SQL)
│   └── extension/                (Manifest V3, Vite + @crxjs/vite-plugin + React)
│       └── src/
│           ├── manifest.ts           (host permissions, content script matches)
│           ├── content/
│           │   ├── detect.ts         (ATS host allowlist + job-page heuristic)
│           │   ├── scrapeJob.ts      (extract job title/company/description text)
│           │   ├── detectFields.ts   (generic form-field classifier)
│           │   └── fillForm.ts       (fills fields + resume file input)
│           ├── background/
│           │   └── index.ts          (message relay, calls backend fetch)
│           ├── popup/
│           │   └── App.tsx           (review/edit UI, "Fill form" action, past-application lookup)
│           └── options/
│               └── App.tsx           (profile onboarding form)
```

## Key implementation notes

**Shared schemas (`packages/shared`)** — define with `zod`, reused for both the LLM structured-output calls (via `zodOutputFormat`) and the extension's TypeScript types:

- `Profile`: name, contact info, links, work experience[], education[], skills[]
- `JobInfo`: company, team, role title, seniority, requirements[], keywords[]
- `TailoredResume`: summary, ordered/reworded experience bullets per job, skills subset
- `DetectedField`: label, input type, DOM selector, guessed category (first_name/email/phone/resume_upload/question/etc.)
- `QuestionAnswer`: question text, drafted answer

**Job-info extraction (`/extract-job`, Haiku 4.5)** — use `client.messages.parse()` with `output_config.format` built from the `JobInfo` zod schema via `zodOutputFormat` (see `typescript/claude-api/tool-use.md` → Structured Outputs). This guarantees valid JSON without a parsing/retry loop. Input is the content-script-scraped page text (stripped of nav/footer via a simple readability heuristic — largest text block / `<main>` / `[role=main]` fallback to `document.body.innerText`).

**Resume tailoring (`/tailor-resume`, Sonnet 5)** — input is `Profile` + `JobInfo`; output is `TailoredResume` via the same structured-output pattern. Prompt instructs: reorder/reword existing experience bullets to emphasize what's relevant to `JobInfo.requirements`, never fabricate experience not in the base profile.

**PDF rendering (`/render-resume-pdf`)** — use `@react-pdf/renderer` (pure JS, no Chromium download, fast local startup) with a single resume template component that takes `TailoredResume` + contact info as props. Returns PDF bytes; the extension attaches them via `Blob` → `File`.

**Question answering (`/answer-questions`, Sonnet 5)** — input is the list of `DetectedField`s classified as `question` (label text) + `Profile` + `JobInfo`; output is a `QuestionAnswer[]`. User reviews/edits every answer in the popup before fill — never auto-submit.

**Generic field detection (`content/detectFields.ts`)** — for each `<input>`/`<textarea>`/`<select>` on the page, build a signal string from its `label[for]`/aria-label/placeholder/name/id, then classify via keyword matching against a fixed category list (first/last name, email, phone, LinkedIn/portfolio URL, resume file upload, cover letter, freeform question). Anything unmatched with a long-form `<textarea>` and a `?` or imperative phrasing in its label is treated as a "question" field. Keep the classifier as plain heuristics for v1 — no LLM call needed just to find fields.

**Resume file upload** — a content script cannot set `<input type="file">.files` directly. Use the standard `DataTransfer` technique: `const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles: true}))`.

**ATS host detection (`content/detect.ts`)** — content script `matches` in the manifest (or a runtime check) against a host allowlist covering common LinkedIn-redirect targets: `*.greenhouse.io`, `*.ashbyhq.com`, `*.lever.co`, `*.myworkday.com`, `*.smartrecruiters.com`, `*.icims.com`, `*.workable.com`, `*.bamboohr.com`. When matched, the extension badge lights up; clicking it opens the popup.

**Neon Postgres + Drizzle (`apps/backend/src/db`)** — create a free Neon project (neon.tech), which gives a `DATABASE_URL` connection string (`postgres://...neon.tech/...?sslmode=require`) — no local Postgres install needed. Use `@neondatabase/serverless` as the driver with `drizzle-orm/neon-http` (Neon's recommended low-latency HTTP driver; a normal `pg`-based connection also works if the backend later needs transactions across requests). Drizzle ORM (`drizzle-orm` + `drizzle-kit`) defines two tables in `schema.ts`:

- `profiles`: single-row (or multi, if the user wants profile variants later) table holding the structured `Profile` JSON plus `updated_at`.
- `applications`: one row per autofilled application — `id`, `company`, `role_title`, `job_url`, `job_info` (jsonb, the extracted `JobInfo`), `tailored_resume` (jsonb), `answers` (jsonb array of `QuestionAnswer`), `status` (`draft`/`submitted`), `created_at`.

Migrations are generated with `drizzle-kit generate` and applied with `drizzle-kit migrate` (`push` during early development) against the Neon connection string. The `/tailor-resume` and `/answer-questions` routes can query `applications` for prior entries with the same `company` and pass a short summary into the prompt, so the model can vary phrasing instead of repeating a previous answer verbatim. `GET /applications` (and `/applications/:id`) power a "past applications" view in the popup or options page.

**Backend auth/binding** — bind Hono to `127.0.0.1` only (not `0.0.0.0`); the backend process itself stays local, only its DB connection goes out to Neon over TLS. `ANTHROPIC_API_KEY` and `DATABASE_URL` (the Neon connection string) read from env (`.env` file, gitignored — the Neon connection string is a credential and must never be committed).

## Verification

- Create the Neon project and set `DATABASE_URL` in `apps/backend/.env`; `pnpm --filter backend db:migrate` applies Drizzle migrations against Neon; `pnpm --filter backend dev` starts the Hono server on `127.0.0.1:5391`.
- `curl -X POST localhost:5391/extract-job -d '{"pageText":"..."}'` returns valid `JobInfo` JSON.
- `pnpm --filter backend test` (or a manual curl) round-trips `/tailor-resume` and `/render-resume-pdf` and confirms a non-empty PDF byte stream, and that a completed autofill writes a row to `applications` (`curl localhost:5391/applications` lists it back).
- Load the extension unpacked (`pnpm --filter extension build`, then `chrome://extensions` → Load unpacked → `apps/extension/dist`), visit a real Greenhouse and Ashby job posting, confirm the badge lights up, the popup shows detected job info, and "Fill form" populates name/email/phone + attaches the generated PDF + fills any freeform questions with editable draft answers.
- Apply to a second posting from a company already in `applications` and confirm the generated answers vary rather than repeating the stored ones verbatim.
- Confirm no fabricated experience appears in a tailored resume by comparing against the base profile on a few sample jobs.
