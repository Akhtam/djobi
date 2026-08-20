# backend

The local Hono server that does the LLM and database work for djobi: extracting structured Job Info
from a pasted Job Description, tailoring a resume to it, drafting answers to freeform application
questions, rendering the resume PDF, and persisting profiles and applications. Runs on your machine
(`127.0.0.1:5391`); the only cloud dependencies are the Neon Postgres database and the Anthropic API.

Domain terms used below (**Job Info**, **Tailored Resume**, **Question Answer**, **Profile**,
**Application**) are defined in the repo-root `CONTEXT.md`.

## `src/app.ts` / `src/index.ts`

`app.ts` builds and returns the Hono app with all six route modules mounted, and installs an
`onError` handler that renders every uncaught failure as a `BackendErrorBody` (from
`@djobi/shared`'s `wire.ts`) with a 500 — so a route never leaks a stack trace or a bare non-JSON
body to the extension. `structuredCall.ts` handles its one retryable case locally, logs the safe
attempt metadata, and exposes only the final message through the generic error body. It's a separate
module from the entrypoint precisely so route tests can import the app without starting a server.

It also installs `hono/cors` for `apps/dashboard`, which runs on its own dev server and is therefore
a different origin. That `app.use` sits **above** every `app.route` for the same reason the logger
below can't: Hono composes in registration order, so middleware registered after the routes never
runs for a request a route answers. The allowed origin is an explicit list, not `*` — this server
holds an Anthropic key and a live database connection, and any page in the browser can reach
`127.0.0.1`. `src/cors.test.ts` covers both of those, deliberately asserting against a real route
rather than an unknown path, since a broken registration still answers a 404 correctly.

Behind the allowlist sits a second `app.use`: every state-changing method (`POST`, `PATCH`, `PUT`,
`DELETE`) must declare `content-type: application/json`, or the request is refused with a **415**
carrying the same `BackendErrorBody` shape as every other error. This is a CSRF guard, not a parsing
convenience. CORS middleware is header-based — for a non-`OPTIONS` request it omits the allow-origin
header and calls `next()` anyway — so a request the browser never preflights reaches the handler and
its side effect lands even though the attacker can't read the reply. A `POST` skips the preflight
only when its content-type is `text/plain`, `application/x-www-form-urlencoded`, or
`multipart/form-data`, and `c.req.json()` parses the body regardless of the header; requiring
`application/json` (never a simple content-type) forces the preflight the allowlist gets to refuse.
Both real clients already send it, so 415 is a status no correct client sees.

`index.ts` is the entrypoint: starts `app.ts` via `@hono/node-server` bound to `127.0.0.1` (never
`0.0.0.0`) on `$PORT`, defaulting to 5391. It mounts `app` under a wrapper instance carrying
`hono/logger`, rather than calling `app.use(logger())` — Hono composes handlers in registration
order, so middleware added after `app.ts`'s routes never runs for a request a route answers. (It
_does_ run for a 404, which is a convincing way to look correct while logging almost nothing.)

## Debugging

### 1. Is the request even arriving?

`pnpm dev:backend` prints one line per request:

```
<-- POST /answer-questions
--> POST /answer-questions 400 4ms
```

Most "the extension isn't working" questions end here. Note the Analysis Step awaits
`/extract-job` first and only then fires `/tailor-resume` and `/answer-questions` in parallel — so
if `/extract-job` 500s (usually a missing `ANTHROPIC_API_KEY`), the other two are never called and
their absence from this log is the expected consequence, not a second bug.

Uncaught failures are already logged by `app.onError` with the method, path and stack.

### 2. Stepping through it

A bare `debugger` statement does **nothing** unless an inspector client is attached — Node does not
drop into a terminal REPL the way `binding.pry` does. Start the server with one listening:

```bash
pnpm dev:backend:debug        # tsx watch --inspect src/index.ts
```

Then attach with whichever of these you prefer.

**Neovim — `nvim-dap`.** Install the adapter (`:MasonInstall js-debug-adapter`), then:

```lua
local dap = require("dap")

dap.adapters["pwa-node"] = {
  type = "server",
  host = "127.0.0.1",
  port = 8123,
  executable = { command = "js-debug-adapter", args = { "8123" } },
}

dap.configurations.typescript = {
  {
    type = "pwa-node",
    request = "attach",
    name = "Attach to djobi backend",
    address = "127.0.0.1",
    port = 9229,
    cwd = "${workspaceFolder}",
    sourceMaps = true,
    skipFiles = { "<node_internals>/**" },
  },
}
```

`:lua require("dap").continue()` to attach, `:lua require("dap").toggle_breakpoint()` on the line.
`tsx` emits inline source maps, so breakpoints land on the TypeScript source. Don't add
`resolveSourceMapLocations` excluding `node_modules` — this is a pnpm workspace, so `@djobi/shared`
is reached through a `node_modules` symlink and excluding it stops you stepping into shared code.

Note `tsx watch` restarts on every save and drops the connection. For a debugging session, run
without the watcher: `pnpm --filter backend exec tsx --inspect src/index.ts`.

**No plugins.** `node inspect 127.0.0.1:9229` in a second terminal gives a `debug>` prompt:
`cont` to run, and `repl` once it breaks to inspect scope — that `repl` is the `binding.pry`
equivalent.

**A browser.** `chrome://inspect` → _inspect_ under Remote Target, for full DevTools.

### 3. Usually faster than either

Every route is drivable without a server, a port, or the extension:

```ts
const res = await app.request('/answer-questions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ profile, jobInfo, questions }),
});
```

That's what the route tests do. Reproducing a bug as a failing test in `src/routes/*.test.ts` is
generally quicker than attaching to a live process, and leaves something behind that keeps the bug
fixed. `curl` against a running server works too, for a payload you already have.

## `src/routes/` — the HTTP surface

Each route validates its body with zod and delegates. Route tests cover the success and failure
cases relevant to that route; not every suite asserts the same 200 / 400 / 500 triple. A 415 never
reaches a route: the content-type guard in `app.ts` answers a state-changing request with the wrong
`content-type` before any route runs, so route tests always send `content-type: application/json`.

Operation-specific transport bodies and aliases live in `@djobi/shared`'s `wire.ts`, so the backend
and extension use the same contracts instead of private route schemas. Domain write shapes such as
`NewApplication` and `ApplicationSnapshot` remain in `schemas.ts`. See that package's README for why.

| Route                           | Body                            | Delegates to                |
| ------------------------------- | ------------------------------- | --------------------------- |
| `POST /extract-job`             | `ExtractJobRequest`             | `llm/extractJob`            |
| `POST /tailor-resume`           | `TailorResumeRequest`           | `llm/tailorResume`          |
| `POST /answer-questions`        | `AnswerQuestionsRequest`        | `llm/answerQuestions`       |
| `POST /render-resume-pdf`       | `RenderResumePdfRequest`        | `pdf/renderResume`          |
| `GET`/`POST /profile`           | `Profile`                       | `db/profileRepository`      |
| `GET /applications`             | — (optional `?jobUrl=`)         | `db/applicationsRepository` |
| `GET /applications/:id`         | —                               | `db/applicationsRepository` |
| `POST /applications`            | `NewApplication`                | `db/applicationsRepository` |
| `PATCH /applications/:id`       | `ApplicationSnapshot`           | `db/applicationsRepository` |
| `PATCH /applications/:id/stage` | `UpdateApplicationStageRequest` | `db/applicationsRepository` |
| `POST /applications/:id/notes`  | `AddApplicationNoteRequest`     | `db/applicationsRepository` |

Application routes negotiate their response with the explicit `response=compact` query parameter.
Without it, they retain the legacy contracts: `GET /applications?jobUrl=...` returns
`Application[]`, while create, snapshot-update, stage, and note writes return the full updated
`Application`. Legacy writes may perform a follow-up read by id. Current clients request compact
responses: create and snapshot-update return `{ id }`, stage returns `{ id, stage }`, notes return
`{ id, note }`, and `GET /applications?jobUrl=...&response=compact` returns the Duplicate Guard's
count and newest-row metadata without loading full snapshots. Values other than exactly `compact`
use the legacy response.

The extension calls the compact job URL lookup before every analysis. It's a query parameter rather
than its own path because
`/applications/…` is already claimed by the `:id` route, so a sibling `/applications/lookup` would
depend on registration order to not be read as an id.

`PATCH /applications/:id` is the Save Step re-saving a run it already saved once, so it takes an
`ApplicationSnapshot` — `NewApplication` minus `source`, `stage`, and `notes`. Provenance and
interview tracking belong to the persisted record rather than to the autofill snapshot, and a
re-save must not overwrite them.

`PATCH /applications/:id/stage` and `POST /applications/:id/notes` are the dashboard's interview
tracking. They are separate paths rather than fields on `PATCH /applications/:id` precisely because
that route's body excludes `stage` and `notes` — folding them back in would give a re-saved autofill
a way to overwrite tracking history, which is the thing `ApplicationSnapshot` exists to prevent. A
note's `id` and `createdAt` are assigned by `addApplicationNote` and stripped from the request body:
history whose timestamp the sender chose isn't history.

The three model/PDF routes accept operation-specific Profile projections rather than contact,
screening, story, and resume data that their operation never reads. This keeps local HTTP payloads
and paid model context limited to relevant fields.

`render-resume-pdf` returns raw PDF bytes with `content-type: application/pdf`, not JSON, which is
why the extension has a separate `callBackendBinary` for it. The route retains one exact-input
render promise, so Preview and Fill reuse completed or in-flight work without an unbounded cache.

## `src/db/` — persistence (Neon Postgres via Drizzle)

### `schema.ts`

Two tables:

- **`profiles`** — one fixed-id singleton row with `updatedAt` and a `data` jsonb column holding the
  entire `Profile`. A fixed primary key makes saves one atomic `INSERT ... ON CONFLICT DO UPDATE`
  statement. No migration is needed when the Profile shape changes — `data` accepts the whole blob.
- **`applications`** — one row per saved autofill run or manually logged application.
  `company`/`roleTitle`/`jobUrl`/`jobKey` are plain columns
  (so they're queryable without reaching into JSON); `jobInfo`, `tailoredResume` and `answers` are
  jsonb snapshots of what was generated for that specific application, so past applications stay
  readable even if `Profile` or the tailoring prompt changes later. `stage`
  (`applied` → `phone_screen` → `interviewing` → `rejected`) tracks how far it got. `notes` is a
  jsonb array appended to over the life of the application, never overwritten.

  A `status` column (`draft`/`submitted`) sat beside `stage` until migration `0002`. Nothing ever
  wrote `submitted`, so the column held no information and was removed. Its removal does not prove
  that a saved application was submitted; the current flow records no authoritative submission
  event.

### `client.ts`

The Drizzle client used by every repository. Reads `DATABASE_URL` from the environment and throws
immediately if it's unset — fails fast rather than on the first query. Uses
`@neondatabase/serverless` + `drizzle-orm/neon-http`, Neon's low-latency HTTP driver (a plain `pg`
connection also works if the backend ever needs multi-statement transactions within one request).

### `profileRepository.ts` / `applicationsRepository.ts`

Both parse jsonb-backed data rather than casting it: a row written before a schema field existed can
come back without it, and a cast would make the compiler vouch for fields that are `undefined` at
runtime. Parsing applies only defaults explicitly declared by the schema. Profile reads therefore
fill the defaulted prepared-answer fields, but application reads use `ApplicationSchema`, whose
persisted fields are required; an older or malformed application is not silently upgraded.

`applicationsRepository` also holds the reads and writes the extension's later steps need. The
Duplicate Guard gets only a count and newest-row metadata from one projected query. Create and
snapshot-update routes return only the id; Stage updates return id + Stage; Note appends return id +
the generated Note. Full rows are reserved for list and detail reads that consume their snapshots.
The duplicate lookup matches `job_key` — `jobUrl` reduced to a posting identity by `jobKeyForUrl`
in `@djobi/shared`, derived on write and never accepted from a client — backed by
`(job_key, created_at DESC)`. It keeps an exact `job_url` clause beside it for rows written before
that column existed, so an unkeyed row is still found exactly as well as it was before. Matching the
raw URL alone missed a posting revisited through an ad link (`?gh_src=`, `?utm_source=`) or from the
`/apply` screen, which cost a full re-analysis every time.

`applicationsRepository` is deliberately stricter for a single row than for a list. `getApplicationById`
throws if the row won't parse, because returning `null` would claim the application doesn't exist —
a different and untrue thing. The list functions skip an unreadable row with a warning instead, so
one bad row from an older build doesn't hide the entire history behind it.

### `migrations/`

`drizzle-kit` output, applied against Neon. `0000_slimy_manta.sql` creates both tables;
`0001_living_captain_stacy.sql` adds `applications.stage` and `applications.notes`.
`0002_outstanding_black_tom.sql` drops `applications.status`; `0003_abandoned_sir_ram.sql` adds the
Application source; `0004_shocking_wind_dancer.sql` consolidates the Profile to its fixed singleton
id and removes the random id default; `0005_curved_jackal.sql` adds the Duplicate Guard index;
`0006_damp_princess_powerful.sql` adds `applications.job_key` and its index. `0006` backfills
nothing — the key is derived by `jobKeyForUrl`, which needs a URL parser, so existing rows keep a
`NULL` key and go on matching by exact `job_url`.

## `drizzle.config.ts`

Config for the `drizzle-kit` CLI (`pnpm db:generate`, `pnpm db:migrate`). Points at
`src/db/schema.ts`, outputs to `src/db/migrations`, and reads `DATABASE_URL` via `dotenv/config`
since drizzle-kit runs outside the app's own env loading.

## `src/llm/` — the three AI calls

### `client.ts`

The `Anthropic` SDK singleton (picks up credentials from `ANTHROPIC_API_KEY` or an `ant auth login`
profile automatically) and `MODEL`: `claude-sonnet-5`, used by every call. `callStructured` still
takes the model per call, so a cheaper tier can be reintroduced for one call site without a
refactor.

### `structuredCall.ts`

**The one non-obvious file.** The design called for `client.messages.parse()` + `zodOutputFormat()`
(structured outputs), but the installed `@anthropic-ai/sdk` (0.68.0) has neither — no `.parse()`, no
`output_config.format`, no `zodOutputFormat` export. `callStructured()` gets the same effect with
what 0.68.0 supports: it forces a single tool call (`tool_choice: { type: 'tool', name }`) and
validates the tool's `input` against the zod schema (`schema.safeParse`) before returning.

The tool's `input_schema` is **derived from that same zod schema** via `zod-to-json-schema` (pinned
exact at 3.24.6 to match the installed zod), with `$refStrategy: 'none'` so the schema stays flat —
Anthropic's `input_schema` doesn't dereference `$ref`/`definitions`. There are no hand-maintained
JSON Schema mirrors anywhere in this package; if one appears, it's a regression.

If the SDK is upgraded and `.parse()`/`zodOutputFormat` become available, this is the only function
that needs to change — all three call sites go through it.

### `extractJob.ts`

Takes the candidate-reviewed **Job Description** field (whether manually pasted or
populated by Autofill's focused page extractor), forces the `report_job_info` tool, and returns a
validated `JobInfo`. The prompt deliberately does not describe the input as raw scraped page text;
told that, a model tolerates and mines junk that the extractor is required to reject.

### `tailorResume.ts`

Takes the Profile's skills/work experience plus `JobInfo`, and returns a validated
`TailoredResume`. Post-processing restores company/title/date metadata from the Profile, drops
fabricated entries and skills, and applies model-authored bullets only to an unambiguous matching
experience entry. The prompt also explicitly forbids inventing experience.

### `answerQuestions.ts`

Sonnet call. Takes the answer-writing projection of `Profile` (work experience, education, skills,
and stories), `JobInfo`, and a list of `{ fieldId, question, options?, knownAnswer? }`; returns
validated `QuestionAnswer`s, each recording which `Story.id`s it drew on. Invalid choice answers are
omitted during post-processing, so the result is not guaranteed to contain one answer per input.
Short-circuits to `[]` without an API call when there are no questions.

Two constraints worth knowing:

- **`options`** — when present, reconciliation accepts only one unambiguous option match. It also
  restores authoritative question text/order, rejects duplicate or unknown field ids, and filters
  `sourceStoryIds` against the Profile.
- **`knownAnswer`** — a fact from the Profile that the answer must honor, set when the Profile
  answers a question but its stored wording maps onto none of this form's options unambiguously
  (e.g. a stored "No" against "I do not require sponsorship now or in the future"). The prompt
  treats it as binding, and post-processing independently maps high-confidence authorization and
  sponsorship polarity. If no unique safe mapping exists, the answer is omitted.

## `src/pdf/renderResume.tsx`

A single `@react-pdf/renderer` template. Contact info and education come from the
`RenderResumePdfProfile` projection (not job-specific); skills and work experience come from the
`TailoredResume`.

The render **fits itself to one page**: it renders at the researched density, counts pages off the
PDF's own page tree, and re-renders one step tighter down a four-step ladder until it fits. Every
step stays inside a sourced range and no step touches `fontSize` — leading and whitespace are
spendable, legibility is not. Past ~5 roles × 6 bullets it returns two pages with all content rather
than truncating. The common case costs exactly one render. See
`docs/resume-design-conventions.md` for where the numbers come from.

## `*.test.ts`

LLM modules follow one pattern: `vi.mock('./client.js', ...)` replaces `anthropic.messages.create`
with a `vi.fn()` (via `vi.hoisted`, since `vi.mock` factories run before top-level `const`s), so no
test ever calls the real API. Each checks the right model and forced `tool_choice`, that the prompt
carries the data it should, the happy path, and a clear throw when the model returns no tool call or
one that fails validation.

`renderResume.test.ts` uses no mocking — there's no network involved — and reads the rendered text
back out with `unpdf`, so a layout regression can actually fail a test.

`db/database.integration.test.ts` uses PGlite's PostgreSQL engine to execute the optimized window
query and migrations `0004`/`0005`, including duplicate, empty-table, and index cases.

## `vitest.config.ts`

Same minimal Node-environment config as `packages/shared`.

## `.env.example`

Template for the real `.env` (gitignored): `DATABASE_URL` (Neon connection string),
`ANTHROPIC_API_KEY`, `PORT`.

The package has its own `tsconfig.json` and builds JSX with the automatic `react-jsx` runtime. Run
`pnpm --filter backend build` to compile it, `pnpm --filter backend test` for this package's tests,
or `pnpm test` for the whole workspace.
