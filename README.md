<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/readme/banner-light.svg">
  <img alt="djobi — every application tailored, every outcome tracked" src=".github/readme/banner-light.svg">
</picture>

# djobi

A Chrome extension that autofills job applications on ATS sites (Greenhouse, Ashby, Lever, Workday,
...) with an AI-tailored resume and drafted answers to freeform questions, backed by a local
server, a persisted history of past applications, and a web dashboard for tracking them. See
`PROGRESS.md` for what's built and `CONTEXT.md` for domain terminology.

## Architecture

- `packages/shared` — zod schemas shared by every app (`Profile`, `JobInfo`, `TailoredResume`, etc.)
- `packages/http-client` — the typed backend client shared by the extension and dashboard.
- `packages/profile-editor` — the profile onboarding/editing form (fields, list sections, the
  load/upload/save workflow), shared by the extension's options page and the dashboard's Profile
  view so both surfaces behave identically by construction.
- `packages/manual-log` — the extract → review → save state machine behind manually logging an
  application, shared by the extension's Log tab and the dashboard's New application view.
- `apps/backend` — local Hono server: LLM calls (multi-provider via OpenRouter), auth (Better Auth —
  email/password, Google), Postgres persistence (Drizzle, over the standard wire protocol — Docker,
  a local install, or a serverless cloud database all work), resume PDF rendering. Runs on
  `127.0.0.1:5391`.
- `apps/extension` — MV3 Chrome extension (Vite + `@crxjs/vite-plugin` + React): content scripts
  that detect application forms and fill them, a background service worker that runs the pipeline,
  an options page (profile setup), and a side panel with **Autofill** (scrape or paste/review/fill),
  **Log**, and **Ask**
  tabs. There is no popup — the toolbar icon opens the side panel, which survives tab switches and
  clicking away.
- `apps/dashboard` — Vite + React web app (`localhost:5174`) for browsing saved applications,
  editing your profile, and reviewing keyword-gap analytics across everything you've applied to. A
  separate app rather than an extension page: it needs no `chrome.*` API, so it stays out of the MV3
  bundle. Its backend calls are same-origin — through Vite's dev proxy locally, nginx under Docker.

## Prerequisites

- [Docker](https://www.docker.com) (recommended — runs the whole server side for you), **or**
  Node.js 26 (`.nvmrc`; the root `engines` field requires >= 22) and `pnpm` 11 (see `devEngines` in
  `package.json`) for a fully manual setup
- Node.js/pnpm and Google Chrome regardless of which you picked above — the extension can't run in
  a container at all, so building and loading it (step 2) always needs both
- An [OpenRouter](https://openrouter.ai) API key
- A Postgres database if you're going the manual route — any of three options, no cloud account
  required unless you want one (see Option B below)

## 1. Get the server side running

Pick one option — both end with the backend and dashboard running and the database migrated.
Everything from step 2 onward is identical either way.

### Option A: Docker (recommended)

```bash
cp apps/backend/.env.example apps/backend/.env
```

Edit `apps/backend/.env` and fill in `OPENROUTER_API_KEY` and `BETTER_AUTH_SECRET` (generate the
secret with `openssl rand -base64 32`). Leave `DATABASE_URL` as-is — it already points at the
Postgres container this brings up.

```bash
docker compose up -d
```

Migrations run automatically — a one-shot `migrate` service applies them before `backend` starts.

`docker compose up -d` builds and starts `db` + `backend` + the built `dashboard` together, one
origin — nginx (the `dashboard` container) reverse-proxying the backend exactly the way
`apps/dashboard/vite.config.ts`'s dev proxy does (`docker/dashboard.nginx.conf`), the same topology
`docs/adr/0001-cloudflare-single-worker.md` already commits this project to for a real deploy.
Dashboard: `http://localhost:5174`. Backend: `http://127.0.0.1:5391` (the extension always calls
this directly, container or not).

This is a **preview** path, not a development one — neither container has hot reload (the backend
restarts only if the whole container restarts; the dashboard is a static `vite build`, not
`vite dev`). Use Option B instead if you're changing backend or dashboard code.

`pnpm db:generate` regenerates migrations after changing `apps/backend/src/db/schema.ts`, the same
as Option B below. `docker compose down` stops everything, keeping the Postgres volume; add `-v` to
also drop it.

### Option B: Manual (without Docker)

```bash
pnpm install
```

Start a database — the backend connects over the standard Postgres wire protocol (`pg`), not a
cloud-specific driver (see `docs/adr/0002-postgres-driver-for-local-dev.md`), so any of these
work — pick one:

- **Docker, for just the database:** `pnpm db:up` (a container, persisted in a named volume;
  `pnpm db:down` stops it, keeping the volume, and `pnpm db:logs` follows its output)
- **A Postgres you already have installed locally:** `createdb djobi`
- **A serverless cloud database** (e.g. [Neon](https://neon.tech), [Supabase](https://supabase.com),
  or another Postgres-compatible host), for a database that persists in the cloud rather than on
  your machine: create a project there and copy its connection string

```bash
cp apps/backend/.env.example apps/backend/.env
```

Edit `apps/backend/.env`. `.env.example` documents all three `DATABASE_URL` shapes above; the
Docker one is filled in by default:

```
DATABASE_URL=postgres://djobi:djobi@127.0.0.1:5432/djobi
OPENROUTER_API_KEY=sk-or-v1-...
PORT=5391
BETTER_AUTH_SECRET=
```

`DATABASE_URL`, `OPENROUTER_API_KEY` and `BETTER_AUTH_SECRET` are required — the backend throws on
its first auth request if `BETTER_AUTH_SECRET` is unset (generate one with `openssl rand -base64 32`). `PORT`
defaults to 5391. The rest of `apps/backend/.env.example` (`BETTER_AUTH_URL`, `PUBLIC_ORIGINS`,
`NODE_ENV`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) is optional and only needed for a real
deploy or Google sign-in — see `docs/multi-tenant-auth.md`. Email/password sign-in works with none
of them set.

Most of the local wiring is otherwise deliberately hardcoded rather than configurable:

- The bind address defaults to `127.0.0.1`, never `0.0.0.0`, on a bare `pnpm dev:backend` run
  (`apps/backend/src/index.ts`) — an override (`HOST` env var) exists only for the Docker Compose
  backend service in Option A, where "every interface" means every other container on that one
  Docker network rather than the LAN.
- The CORS allowlist always includes `http://localhost:5174, http://127.0.0.1:5174`
  (`apps/backend/src/app.ts`), plus whatever real origins `PUBLIC_ORIGINS` lists. Never a wildcard:
  this server holds an API key and any page in your browser can reach `127.0.0.1`.
- Locally, the dashboard never calls `http://127.0.0.1:5391` directly — every request is a relative
  path that `apps/dashboard/vite.config.ts`'s dev-server proxy forwards to it, so the browser sees
  the dashboard and backend as the same origin (needed for the session cookie). The extension has
  no origin of its own to proxy through, so it calls `http://127.0.0.1:5391` directly
  (`apps/extension/src/extensionConfig.ts`, which also feeds the manifest's host permissions).

Both apps read a `VITE_BACKEND_ORIGIN` env var (see `apps/extension/.env.example` and
`apps/dashboard/.env.example`) — set it to the real deployed backend's origin when building for a
real deploy. Leave it unset locally.

Run migrations against your database:

```bash
pnpm db:generate   # only needed after changing apps/backend/src/db/schema.ts
pnpm db:migrate
```

Then run the backend:

```bash
pnpm dev:backend
```

Starts the Hono server on `http://127.0.0.1:5391` (via `tsx watch`, restarts on file changes).
Leave this running — the extension talks to it directly. In another terminal, run the dashboard:

```bash
pnpm dev:dashboard
```

Starts the dashboard dev server on `http://localhost:5174`, with Vite HMR.

## 2. Build and load the extension

The extension needs a real `dist/` build to load into Chrome (a plain `vite dev` server isn't
enough for an MV3 unpacked extension):

```bash
pnpm build:extension
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select `apps/extension/dist`
4. Re-run `pnpm build:extension` after making changes, or use
   `pnpm --filter extension dev` for `@crxjs/vite-plugin`'s watch/HMR mode, then click the reload
   icon on the extension card in `chrome://extensions`

## 3. Create an account

The dashboard is already running from step 1, either way you set it up. Open
`http://localhost:5174`, go to **Create an account**, and sign up with an email and password
(8+ characters). This is the only sign-up surface — the extension has none; it's a companion to an
account created here. Google sign-in is also wired but needs `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET` configured (see Option B's `.env` step), so email/password is the default
path.

## 4. Sign in to the extension

Right-click the djobi icon → **Options**, and sign in with the same email/password. The extension
and dashboard share one Better Auth session — signing in on either surface, or opening the other
while already signed in on one, authenticates both (`apps/extension/src/lib/sharedSessionCookie.ts`).

## 5. Set up your profile

Still on the options page:

1. Fill in your contact info, links, work experience, education, skills, and stories
2. Also fill in the **prepared answers** — work authorization, sponsorship and the rest. These are
   answered from your profile verbatim and never sent to a model to guess at
3. Save — this is stored server-side and used to seed every tailored resume/answer

Already have a resume? The options page's **Upload resume** action parses an uploaded PDF and
pre-fills the form for you to review and edit before saving — it never auto-saves or overwrites a
field you've already filled in with nothing.

## 6. Use it

Navigate to the application form for a job you want to apply to, and click the djobi icon to open
the side panel:

1. **Paste the job description or click Scrape job description.** Scraping reads every addressable
   frame, prefers `JobPosting` JSON-LD, and falls back to focused, scored DOM sections while excluding
   forms and navigation. It fills the same editable field and never starts analysis automatically
2. **Review the description.** It is retained in session storage across same-job routes, including
   Ashby's Overview → Application transition. The original posting URL remains the URL used for
   duplicate checks and saving
3. **Analyze** — extracts structured job info, tailors a resume to it, and drafts answers to any
   freeform questions the form asks. If you've already saved an application for this posting, the
   panel says so and spends no LLM calls until you choose **Analyze and apply anyway**
4. **Review and edit** every drafted answer. Nothing is filled until you say so. If an application
   route introduces questions that were absent during analysis, Fill is disabled until you re-analyze
5. **Fill form** writes the reviewed values into the page and attaches the generated resume PDF. It
   reports verified counts and unresolved required fields when the content script responds. If no
   frame responds, attempted counts are retained but the result is marked **Fill unverified**
6. **Save application** records the current job info, tailored resume and answers. Saving is
   normally explicit and separate from filling; re-saving after another edit or fill updates the
   same record rather than creating a second one. Applications have no draft/submitted status

djobi never submits the employer's form; the candidate does that on the ATS. But if you fill a form
with djobi and then click the ATS's own submit button, djobi notices and saves the application for
you automatically — a toast on the page confirms it, and a ✓ badge on the toolbar icon survives the
navigation in case the panel and toast are both gone by the time you look back
(`apps/extension/src/content/submitWatch.ts`, `savedToast.ts`,
`apps/extension/src/background/saveBadge.ts`). Saving (manual or automatic) does not verify that the
employer actually received the submission — only that the candidate clicked submit. Analysis,
filling and saving all run in the background service worker, so closing the panel mid-run doesn't
lose them. Chrome may still stop that worker mid-step; the next one to start turns any operation its
predecessor abandoned into a visible error you can retry from, rather than a step that appears to run
forever.

Use the **Log** tab for an application made without djobi. Its URL field follows the active tab until
you edit it; it extracts Job Info from a pasted posting and saves a manual Application without
detecting or writing the page.

Use the **Ask** tab to draft or revise a single application answer — a question the detector missed,
one from a form djobi can't see, or a drafted answer you want reworked. It never writes to the page:
opened from a question card it offers **Use this answer**, which writes back to the run's answer;
opened cold it offers a copy button.

The panel and options page share a light/dark theme, toggled from the icon in either header and
persisted in `chrome.storage.local`.

## 7. Browse past applications

Back at `http://localhost:5174` (started in step 1), signed in, the dashboard is more than a
read-only list:

- **Applications** (`#/`) lists every saved application (filter by stage, search by title or
  company) and opens each one (`#/applications/:id`) to edit its stage, add notes, and review the
  saved job info, tailored resume and drafted answers. Notes can't be edited, but a single note can
  be deleted (behind a confirmation), and so can the whole application.
- **Profile** (`#/profile`) is the same profile editor as the extension's options page, built from
  the same `@djobi/profile-editor` package, so you can set up or edit your profile from either
  surface — the options page is no longer the only place to do this.
- **Analytics** (`#/analytics`) is a retrospective on the postings you've already saved as
  applications: which keywords they ask for, and which of them your profile doesn't evidence. It's
  a gap analysis over your own saved postings, not a survey of the job market.
- **New application** is the dashboard's counterpart to the extension's Log tab, for recording an
  application made without djobi.

The backend's CORS allowlist covers the dashboard's local origins plus whatever `PUBLIC_ORIGINS`
lists — see `apps/backend/README.md`.

## Tests

```bash
pnpm test                                # every package
pnpm --filter backend test               # backend only
pnpm --filter extension test             # extension only
pnpm --filter dashboard test             # dashboard only
pnpm --filter @djobi/shared test         # shared schemas only
pnpm --filter @djobi/http-client test    # shared HTTP transport only
pnpm --filter @djobi/profile-editor test # shared profile editor only
pnpm --filter @djobi/manual-log test     # shared manual-log flow only
```

## Other scripts

```bash
pnpm typecheck      # tsc across every package
pnpm build          # the four workspace packages, then every app's own build
pnpm format         # prettier --write .
pnpm format:check   # prettier --check .
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `typecheck`, `build` and `test` on every pull
request and every push to `main`, on Linux — the host here is macOS, and a case-sensitive filesystem
catches import-casing bugs that are invisible locally.

Known issues and loose ends live in `PROGRESS.md` → "Known loose ends".

## How the pieces connect

```mermaid
flowchart LR
  subgraph browser["Chrome browser"]
    subgraph ats["ATS tab (any http/https page, all frames)<br/>greenhouse · ashby · lever · workday · white-labeled boards"]
      cs["content script<br/>detect · scrape · fill · submit"]
      form["employer's form (DOM)<br/>inputs · radios · file upload"]
    end
    sw["background service worker<br/>router.ts → applicationPipeline<br/>runClaim · keepAlive (20s beat)<br/>apiDetectors (ATS oracles)<br/>recovery sweep on wake"]
    store[("chrome.storage.session<br/>tabStore/record per tab:<br/>pipeline run state · detected frames<br/>job context · authToken")]
    panel["side panel (React)<br/>Autofill · Log · Ask tabs<br/>usePipelineRun ← onChanged<br/>backendClient (bearer)"]
    options["options page<br/>Profile editor + login<br/>@djobi/profile-editor<br/>resume PDF upload"]
    dash["dashboard SPA · localhost:5174<br/>(Vite, proxy → backend)"]
  end

  subgraph server["Local server + cloud"]
    backend["Hono backend · 127.0.0.1:5391<br/>cors allowlist → json-only CSRF guard<br/>GET /healthz (public)<br/>/api/auth/* (Better Auth)<br/>requireAuth → userId<br/>POST /analyze /extract-job /tailor-resume /answer-*<br/>GET|POST /profile (+extract-resume)<br/>/applications CRUD, stage, notes<br/>POST /render-resume-pdf (@libpdf)<br/>onError → {error, code} JSON"]
    llm["OpenRouter (one key)<br/>gemini-3.1-flash-lite → extractJob, extractResume<br/>claude-sonnet-5 → tailorResume, answerQuestions, answerChat<br/>data_collection: deny · 1 semantic retry"]
    db[("Postgres<br/>drizzle node-postgres<br/>users · session/account<br/>profiles (jsonb) · applications")]
    atsApi["Public ATS APIs (called from service worker)<br/>boards-api.greenhouse.io<br/>api.smartrecruiters.com · *.workable.com<br/>→ required flags + real choice labels"]
  end

  cs --> form
  cs -- "REPORT_JOB_PAGE<br/>REPORT_SUBMISSION" --> sw
  sw -. "SCAN_PAGE · FILL_FORM<br/>SHOW_SAVED_TOAST" .-> cs
  sw --> store
  panel -- "START_ANALYSIS/FILL/SAVE<br/>UPDATE_RUN · CHECK_RUN" --> sw
  store -. "storage.onChanged" .-> panel
  panel -. "SCRAPE_JOB_DESCRIPTION" .-> cs
  sw -- "fetch + Bearer" --> backend
  panel -- "Bearer" --> backend
  dash -- "cookie (same-origin via proxy)" --> backend
  sw -. "GET schema" .-> atsApi
  backend -- "generateObject(zod)" --> llm
  backend --> db
```

The browser holds everything that touches the page or the candidate's session. The backend holds
every secret (OpenRouter key, database URL, auth secret). Paid work always runs on the backend. The
three application steps (Analyze, Fill, Save) are started from the **service worker**, so a run
keeps going if the panel closes. The panel's other calls (Ask tab chat, Log tab job extraction,
resume PDF preview) and the options page's resume import call the backend directly, and stop if
their page closes.

### A job application, end to end

1. Content script decides a page is an application form (`detect.ts`) and reports its fields to the
   worker.
2. Worker stores them per frame and, if the URL is Greenhouse, SmartRecruiters or Workable, fills in
   details from that ATS's API.
3. Candidate pastes or scrapes the Job Description in the panel and clicks **Analyze**.
4. Worker checks for a duplicate first, then makes one `POST /analyze` call: extract Job Info, then
   tailor the resume and answer questions in parallel.
5. Candidate reviews and edits, then clicks **Fill**: the worker rescans the page, renders the PDF
   and sends `FILL_FORM`. The page reports back what it actually kept.
6. Clicking **Save** (or pressing the site's own Submit) runs `POST /applications`, using the `runId`
   as the idempotency key.
7. The dashboard then lists the application and tracks its Stage and Notes.

### Design rules that recur everywhere

- **Ports + fakes**: `BackendClient`, `DashboardClient`, `ApplicationStore`, `ProfileStore`,
  `PipelineDeps`. Each has a real adapter and a fake. Tests never hit the network.
- **Zod on both ends**: every wire shape lives in `@djobi/shared`. Clients _parse_ request bodies,
  which strips Profile fields the model shouldn't see.
- **Lazy Proxies** for `db`, `auth` and `openrouter`: nothing reads env at import time, so the code
  stays ready to run on Cloudflare Workers (ADR-0001).
- **Abort signals** go from the browser through Hono into `generateObject`, so an abandoned analysis
  stops being billed.
- **Fails open**: the Duplicate Guard and ATS oracles fall back to the plain result instead of
  blocking.
