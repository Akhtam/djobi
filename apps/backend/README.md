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
body to the extension. A failure from `structuredCall.ts` carries a `kind` alongside the message, so
the extension can branch on _why_ a structured call failed without matching substrings of English.
It's a separate module from the entrypoint precisely so route tests can import the app without
starting a server.

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

Each route validates its body with zod and delegates; each has a test asserting the 200 / 400
(validation) / 500 (downstream throw) triple.

Every Application Pipeline body is validated against the shared schema in `@djobi/shared`'s
`wire.ts` — the same one `lib/backendClient.ts` builds the request against — rather than a schema
private to the route. See that package's README for why.

| Route                     | Body                     | Delegates to                |
| ------------------------- | ------------------------ | --------------------------- |
| `POST /extract-job`       | `ExtractJobRequest`      | `llm/extractJob`            |
| `POST /tailor-resume`     | `TailorResumeRequest`    | `llm/tailorResume`          |
| `POST /answer-questions`  | `AnswerQuestionsRequest` | `llm/answerQuestions`       |
| `POST /render-resume-pdf` | `RenderResumePdfRequest` | `pdf/renderResume`          |
| `GET`/`POST /profile`     | `Profile`                | `db/profileRepository`      |
| `GET /applications`       | — (optional `?jobUrl=`)  | `db/applicationsRepository` |
| `GET /applications/:id`   | —                        | `db/applicationsRepository` |
| `POST /applications`      | `NewApplication`         | `db/applicationsRepository` |
| `PATCH /applications/:id` | `ApplicationSnapshot`    | `db/applicationsRepository` |

`GET /applications` takes `?jobUrl=` to narrow the list to one posting — the extension's duplicate
guard calls it before every analysis. It's a query parameter rather than its own path because
`/applications/…` is already claimed by the `:id` route, so a sibling `/applications/lookup` would
depend on registration order to not be read as an id.

`PATCH /applications/:id` is the Save Step re-saving a run it already saved once, so it takes an
`ApplicationSnapshot` — `NewApplication` minus `stage` and `notes`. Those belong to tracking the
application rather than to the autofill run, and a re-save must not overwrite them.

`tailor-resume.ts` is the only route with logic of its own: it calls
`listApplicationsByCompany(jobInfo.company)` and builds a one-line-per-application summary to pass
into `tailorResume` as `priorApplicationsSummary`, so tailoring doesn't repeat itself word-for-word
across applications to the same employer. This is deliberately server-computed — the route does not
accept a client-supplied summary.

`render-resume-pdf` returns raw PDF bytes with `content-type: application/pdf`, not JSON, which is
why the extension has a separate `callBackendBinary` for it.

## `src/db/` — persistence (Neon Postgres via Drizzle)

### `schema.ts`

Two tables:

- **`profiles`** — `id`, `updatedAt`, and a single `data` jsonb column holding the entire `Profile`
  from `@djobi/shared` as one blob (see that package's README for why). No migration is needed when
  `Profile`'s shape changes — `data` just accepts whatever's in it.
- **`applications`** — one row per job you autofill. `company`/`roleTitle`/`jobUrl` are plain columns
  (so they're queryable without reaching into JSON); `jobInfo`, `tailoredResume` and `answers` are
  jsonb snapshots of what was generated for that specific application, so past applications stay
  readable even if `Profile` or the tailoring prompt changes later. `status` (`draft`/`submitted`)
  and `stage` (`applied` → … → `offer`/`rejected`/`withdrawn`) are separate columns answering
  separate questions — whether it went out, and how far it got. `notes` is a jsonb array appended to
  over the life of the application, never overwritten.

### `client.ts`

The Drizzle client used by every repository. Reads `DATABASE_URL` from the environment and throws
immediately if it's unset — fails fast rather than on the first query. Uses
`@neondatabase/serverless` + `drizzle-orm/neon-http`, Neon's low-latency HTTP driver (a plain `pg`
connection also works if the backend ever needs multi-statement transactions within one request).

### `profileRepository.ts` / `applicationsRepository.ts`

Both parse their jsonb columns rather than casting them: a row written before a schema field existed
comes back without it, and `row.data as Profile` asserts a shape the row doesn't have — the compiler
then vouches for fields that are `undefined` at runtime, and the mismatch surfaces as a
`Cannot read properties of undefined` somewhere far away. Parsing applies the schema's defaults, so
an older row is upgraded on read.

`applicationsRepository` also holds the reads and writes the extension's later steps need:
`listApplicationsByJobUrl` (newest first — the duplicate guard's lookup), `updateApplication` (the
Save Step replacing a snapshot it already saved), `listApplicationsByCompany` (what
`/tailor-resume` builds `priorApplicationsSummary` from), and `updateApplicationStage`. That last
one has no route yet — see `PROGRESS.md`'s Phase 7.

`applicationsRepository` is deliberately stricter for a single row than for a list. `getApplicationById`
throws if the row won't parse, because returning `null` would claim the application doesn't exist —
a different and untrue thing. The list functions skip an unreadable row with a warning instead, so
one bad row from an older build doesn't hide the entire history behind it.

### `migrations/`

`drizzle-kit` output, applied against Neon. `0000_slimy_manta.sql` creates both tables;
`0001_living_captain_stacy.sql` adds `applications.stage` and `applications.notes`.

## `drizzle.config.ts`

Config for the `drizzle-kit` CLI (`pnpm db:generate`, `pnpm db:migrate`). Points at
`src/db/schema.ts`, outputs to `src/db/migrations`, and reads `DATABASE_URL` via `dotenv/config`
since drizzle-kit runs outside the app's own env loading.

## `src/llm/` — the three AI calls

### `client.ts`

The `Anthropic` SDK singleton (picks up credentials from `ANTHROPIC_API_KEY` or an `ant auth login`
profile automatically) and the `MODELS` map: `claude-haiku-4-5` for extraction (cheap, high-volume,
purely structured), `claude-sonnet-5` for writing (resume tailoring, question answers — quality
matters more here).

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

Haiku call. Takes the **pasted Job Description** (not scraped page text — the extension stopped
scraping, because the application form is a different page from the posting), forces the
`report_job_info` tool, and returns a validated `JobInfo`. The prompt deliberately does not tell the
model it's reading scraped text; told that, it tolerates and mines junk.

### `tailorResume.ts`

Sonnet call. Takes `Profile` + `JobInfo` and an optional `priorApplicationsSummary` (built by the
route, see above), returns a validated `TailoredResume`. The prompt explicitly forbids inventing
experience not present in the Profile.

### `answerQuestions.ts`

Sonnet call. Takes `Profile` (particularly `profile.stories`), `JobInfo`, and a list of
`{ fieldId, question, options?, knownAnswer? }`; returns one `QuestionAnswer` per question, each
recording which `Story.id`s it drew on. Short-circuits to `[]` without an API call when there are no
questions.

Two constraints worth knowing:

- **`options`** — when present, the answer must be one of them verbatim. The prompt asks for this,
  and `constrainToOptions` enforces it afterwards using `matchOptionLabel` from `@djobi/shared` —
  the same rule `content/fillForm.ts` uses to find the element to click, which is why it has to
  live in the shared package.
- **`knownAnswer`** — a fact from the Profile that the answer must honor, set when the Profile
  answers a question but its stored wording maps onto none of this form's options unambiguously
  (e.g. a stored "No" against "I do not require sponsorship now or in the future"). The prompt
  treats it as binding, not as context: these are legal declarations about work authorization, and
  an answer that reverses the candidate's stated position is worse than no answer.

## `src/pdf/renderResume.tsx`

A single `@react-pdf/renderer` template. Contact info and education come from the `Profile` (not
job-specific); summary, skills and work experience come from the `TailoredResume`.

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

## `vitest.config.ts`

Same minimal Node-environment config as `packages/shared`.

## `.env.example`

Template for the real `.env` (gitignored): `DATABASE_URL` (Neon connection string),
`ANTHROPIC_API_KEY`, `PORT`.

## Known gap

There is **no `tsconfig.json` in this package**, so `pnpm --filter backend build` fails. `pnpm
dev:backend` (via `tsx`) is unaffected. One consequence leaks into the source: JSX in
`renderResume.tsx` uses the classic transform, so it needs an explicit `import React from 'react'`
for `React.createElement` to resolve — switch to the automatic runtime once a tsconfig exists.

Run this package's tests with `pnpm --filter backend test`, or the whole workspace's with `pnpm test`
from the repo root.
