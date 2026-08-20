# djobi

A Chrome extension that autofills job applications on ATS sites (Greenhouse, Ashby, Lever, Workday,
...) with an AI-tailored resume and drafted answers to freeform questions, backed by a local
server, a persisted history of past applications, and a web dashboard for tracking them. See
`PROGRESS.md` for what's built and `CONTEXT.md` for domain terminology.

## Architecture

- `packages/shared` — zod schemas shared by every app (`Profile`, `JobInfo`, `TailoredResume`, etc.)
- `apps/backend` — local Hono server: LLM calls (Anthropic), Postgres persistence (Neon + Drizzle),
  resume PDF rendering. Runs on `127.0.0.1:5391`.
- `apps/extension` — MV3 Chrome extension (Vite + `@crxjs/vite-plugin` + React): content scripts
  that detect application forms and fill them, a background service worker that runs the pipeline,
  an options page (profile setup), and a side panel with **Autofill** (scrape or paste/review/fill),
  **Log**, and **Ask**
  tabs. There is no popup — the toolbar icon opens the side panel, which survives tab switches and
  clicking away.
- `apps/dashboard` — Vite + React web app (`localhost:5174`) for browsing saved applications and
  tracking each one's stage and notes. A separate app rather than an extension page: it needs no
  `chrome.*` API, so it talks to the backend over CORS like any other origin.

## Run it with Docker

Recommended on Linux and Windows. `pnpm-lock.yaml` pins platform-specific binaries for esbuild,
rollup and lightningcss, so a `node_modules/` installed on macOS does not work on Linux and vice
versa — installing inside the image is what makes this repo behave the same everywhere. You need
Docker, a Neon connection string and an Anthropic key; nothing else, not even Node.

```bash
cp apps/backend/.env.example apps/backend/.env   # then fill in DATABASE_URL and ANTHROPIC_API_KEY
docker compose up                                # or: pnpm docker:dev
```

Backend on `http://127.0.0.1:5391`, dashboard on `http://localhost:5174`, both hot-reloading as you
edit files on your host. Then build the extension and load `apps/extension/dist` unpacked, exactly
as in step 4 below:

```bash
docker compose run --rm extension-build   # or: pnpm docker:build:extension
docker compose run --rm test              # or: pnpm docker:test
```

Tests need no database and no API key — the one test that touches the schema runs PGlite
in-process. Running them is also the quickest check that your container's native binaries are sound.

There is deliberately **no database service**: `apps/backend/src/db/client.ts` reaches Postgres over
Neon's HTTP driver (`@neondatabase/serverless`), which a plain `postgres:` container cannot answer
without a proxy sidecar. Point `DATABASE_URL` at your own free Neon branch instead. Run migrations
from your host (`pnpm db:migrate`) — `drizzle-kit` connects over TCP rather than through that driver.

`node_modules` lives in named volumes seeded from the image once and never refreshed, so after
pulling a change to `pnpm-lock.yaml` run `docker compose down -v && docker compose build`.

The rest of this README is the native setup. Docker exists for parity, not to replace a working host
setup — every environment variable it sets falls back to the native behaviour when unset, so if
`pnpm dev:backend` already works for you, nothing here changes that.

## Prerequisites

- Node.js and `pnpm` (`11.22.0` — see `packageManager` and `devEngines` in `package.json`)
- A [Neon](https://neon.tech) Postgres database (or any Postgres connection string)
- An Anthropic API key
- Google Chrome (to load the extension)

## 1. Install dependencies

```bash
pnpm install
```

## 2. Configure the backend

```bash
cp apps/backend/.env.example apps/backend/.env
```

Edit `apps/backend/.env`:

```
DATABASE_URL=postgres://user:password@your-neon-host/djobi?sslmode=require
ANTHROPIC_API_KEY=sk-ant-...
PORT=5391
```

A few optional variables are read too, each defaulting to the behaviour above when unset:

| Variable              | Default                                       | Notes                                                                                                                                                                        |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                | `127.0.0.1`                                   | Interface the backend binds. Compose sets `0.0.0.0` — inside a container, loopback is the container's own and a published port would reach nothing.                          |
| `CORS_ORIGINS`        | `http://localhost:5174,http://127.0.0.1:5174` | Comma-separated allowlist. Never a wildcard: this server holds an API key and any page in your browser can reach `127.0.0.1`.                                                |
| `VITE_BACKEND_ORIGIN` | `http://127.0.0.1:5391`                       | Dashboard, inlined at build time. The address your **browser** uses — under Docker that is the host-published port, never `http://backend:5391`.                             |
| `VITE_POLL`           | unset                                         | Set to `1` or `true` to make the dashboard's dev server poll for file changes. Docker's host file sharing does not deliver inotify events, so HMR needs this in a container. |

The extension's backend origin is intentionally not configurable — it is hardcoded in
`src/lib/callBackend.ts` and in the manifest's host permissions, and compose publishes the backend on
that same host port so it keeps working unchanged.

Run migrations against your database:

```bash
pnpm db:generate   # only needed after changing apps/backend/src/db/schema.ts
pnpm db:migrate
```

## 3. Run the backend

```bash
pnpm dev:backend
```

Starts the Hono server on `http://127.0.0.1:5391` (via `tsx watch`, restarts on file changes).
Leave this running — the extension talks to it directly.

## 4. Build and load the extension

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

## 5. Set up your profile

With the backend running and the extension loaded:

1. Right-click the djobi icon → **Options**
2. Fill in your contact info, links, work experience, education, skills, and stories
3. Also fill in the **prepared answers** — work authorization, sponsorship and the rest. These are
   answered from your profile verbatim and never sent to a model to guess at
4. Save — this is stored server-side and used to seed every tailored resume/answer

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
6. **Save application** records the current job info, tailored resume and answers. Saving is explicit
   and separate from filling; re-saving after another edit or fill updates the same record rather
   than creating a second one. Applications have no draft/submitted status

djobi never submits the employer's form; the candidate does that on the ATS. Saving does not verify
that submission happened. Analysis, filling and saving all run in the background service worker, so
closing the panel mid-run doesn't lose them.

Use the **Log** tab for an application made without djobi. Its URL field follows the active tab until
you edit it; it extracts Job Info from a pasted posting and saves a manual Application without
detecting or writing the page.

The panel and options page share a light/dark theme, toggled from the icon in either header and
persisted in `chrome.storage.local`.

## 7. Browse past applications

```bash
pnpm dev:dashboard
```

Serves the dashboard on `http://localhost:5174`. With the backend running, it lists every saved
application (filter by stage, search by title or company) and opens each one to edit its stage,
append notes, and review the saved job info, tailored resume and drafted answers. Notes are
append-only. The backend's CORS allowlist covers the dashboard's dev origins only — see
`apps/backend/README.md`.

## Tests

```bash
pnpm test                        # every package
pnpm --filter backend test       # backend only
pnpm --filter extension test     # extension only
pnpm --filter dashboard test     # dashboard only
pnpm --filter @djobi/shared test # shared schemas only
```

Or in a container, on any host OS: `docker compose run --rm test`.

## Other scripts

```bash
pnpm format         # prettier --write .
pnpm format:check   # prettier --check .
```

Known issues and loose ends live in `PROGRESS.md` → "Known loose ends".
