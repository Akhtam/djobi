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
  that detect application forms and fill them, a background service worker that runs the pipeline,
  an options page (profile setup), and a side panel (paste/review/fill). There is no popup — the
  toolbar icon opens the side panel, which survives tab switches and clicking away.

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

1. Right-click the djobi icon → **Options**
2. Fill in your contact info, links, work experience, education, skills, and stories
3. Also fill in the **prepared answers** — work authorization, sponsorship and the rest. These are
   answered from your profile verbatim and never sent to a model to guess at
4. Save — this is stored server-side and used to seed every tailored resume/answer

## 6. Use it

Navigate to the application form for a job you want to apply to, and click the djobi icon to open
the side panel:

1. **Paste the job description** into the panel. This is the only input analysis has — djobi does
   not read the posting off the page, because the application form is usually a different page from
   the ad
2. **Analyze** — extracts structured job info, tailors a resume to it, and drafts answers to any
   freeform questions the form asks. If you've already saved an application for this exact URL, the
   panel says so and spends no LLM calls until you choose **Analyze and apply anyway**
3. **Review and edit** every drafted answer. Nothing is filled until you say so
4. **Fill form** writes the reviewed values into the page and attaches the generated resume PDF. It
   reports how many fields the page actually kept, and lists any required field it couldn't resolve
5. **Save application** records what went out — job info, tailored resume and answers — as a
   `draft` application. Saving is explicit and separate from filling; re-saving after another edit
   or fill updates the same record rather than creating a second one

Nothing is submitted to the employer at any point. Analysis, filling and saving all run in the
background service worker, so closing the panel mid-run doesn't lose them.

The panel and options page share a light/dark theme, toggled from the icon in either header and
persisted in `chrome.storage.local`.

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

Known issues and loose ends live in `PROGRESS.md` → "Known loose ends".
