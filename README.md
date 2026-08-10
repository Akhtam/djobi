# djobi

A Chrome extension that autofills job applications on ATS sites (Greenhouse, Ashby, Lever, Workday,
...) with an AI-tailored resume and drafted answers to freeform questions, backed by a local
server and a persisted history of past applications. See `PROGRESS.md` for what's built and
`CONTEXT.md` for domain terminology.

## Architecture

- `packages/shared` — zod schemas shared by both apps (`Profile`, `JobInfo`, `TailoredResume`, etc.)
- `apps/backend` — local Hono server: LLM calls (Anthropic), Postgres persistence (Neon + Drizzle),
  resume PDF rendering. Runs on `127.0.0.1:5391`.
- `apps/extension` — MV3 Chrome extension (Vite + `@crxjs/vite-plugin` + React): content scripts
  that detect/scrape job pages and fill forms, a background service worker, an options page
  (profile setup), and a popup (review/fill).

## Prerequisites

- Node.js and `pnpm` (`^11.20.0` — see `devEngines` in `package.json`)
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

1. Click the djobi icon → open the options page (or right-click the icon → **Options**)
2. Fill in your contact info, links, work experience, education, skills, and stories
3. Save — this is stored server-side and used to seed every tailored resume/answer

## 6. Use it

Navigate to a job posting on a supported ATS site with an application form. Open the popup:

- If the page looks like a job application, it scrapes the posting, extracts structured job info,
  and drafts a tailored resume + question answers for you to review/edit
- **Fill form** writes the reviewed values into the page, attaches the generated resume PDF, and
  saves a `draft` application record — nothing is submitted to the employer automatically

## Tests

```bash
pnpm test                        # every package
pnpm --filter backend test       # backend only
pnpm --filter extension test     # extension only
pnpm --filter @djobi/shared test # shared schemas only
```

## Other scripts

```bash
pnpm format         # prettier --write .
pnpm format:check   # prettier --check .
```

## Known issues

- `apps/backend` has no `tsconfig.json`, so `pnpm --filter backend build` (production build) fails.
  `pnpm dev:backend` (via `tsx`) is unaffected and works fine for local development.
- See `PROGRESS.md` → "Known loose ends" for more.
