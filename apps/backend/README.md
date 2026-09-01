# backend

The local Hono server that does the LLM and database work for djobi: extracting structured Job Info
from a pasted Job Description, tailoring a resume to it, drafting answers to freeform application
questions, holding a chat about one of those answers, rendering the resume PDF, and persisting
profiles and applications. Runs on your machine
(`127.0.0.1:5391`); the only cloud dependencies are the Neon Postgres database and the Anthropic API.

Domain terms used below (**Job Info**, **Tailored Resume**, **Question Answer**, **Profile**,
**Application**) are defined in the repo-root `CONTEXT.md`.

## `src/app.ts` / `src/index.ts`

`app.ts` builds and returns the Hono app with all four route modules mounted, and installs an
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

Most "the extension isn't working" questions end here. The Analysis Step awaits `/extract-job`, then
fires `/tailor-resume` and `/answer-questions` in parallel. It checkpoints Review as soon as those
finish. If `/extract-job` 500s (usually a missing `OPENROUTER_API_KEY`), neither later route is called
and their absence from this log is expected.

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
| `POST /answer-chat`             | `AnswerChatRequest`             | `llm/answerChat`            |
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
  (`applied` → `phone_screen` → `onsite` → `offer` → `rejected`) tracks how far it got. `notes` is a
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

## `src/llm/` — the model calls

### `client.ts`

The OpenRouter provider instance (credentials from `OPENROUTER_API_KEY`), plus `MODELS` — the map
from _operation_ to pinned model slug that is the whole of the routing policy.

| Operation         | Model                          | Why                                                                                                                         |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `extractJob`      | `google/gemini-3.1-flash-lite` | Highest call volume, and the serial gate the rest of Analysis waits behind. Transcription from text already in front of it. |
| `tailorResume`    | `anthropic/claude-sonnet-5`    | The one call where nuance is the product.                                                                                   |
| `answerQuestions` | `anthropic/claude-sonnet-5`    | Freeform prose grounded in Stories — the same judgement as tailoring.                                                       |
| `answerChat`      | `anthropic/claude-sonnet-5`    | The same drafting task, in a conversation.                                                                                  |

A tier split across one vendor's models (`MODEL`/`FAST_MODEL`) stopped meaning anything once the
models come from several. Anthropic is still reachable — OpenRouter serves it — so putting a call
back on `anthropic/claude-*` is an edit to this map and nothing else. No dual-client fallback path
exists, deliberately: that is a code path with no test coverage waiting to be wrong.

The slugs are exact and verified against OpenRouter's model list. A wrong one is a 404 at request
time rather than a type error.

### `structuredCall.ts`

**The one non-obvious file.** `callStructured()` calls `generateObject` with the zod schema as the
response format, and the object is validated against that schema before it is returned.

Structured output is now each provider's own mechanism rather than a forced tool call, and that
trades one risk for another: OpenRouter's support varies by model **and** by which upstream serves
it. Every call is therefore routed with `require_parameters: true` and `data_collection: 'deny'`,
which makes hosts that cannot honor the schema and any upstream that may retain candidate data
ineligible. Anthropic model slugs additionally order and allow only `anthropic` followed by
`claude-on-aws`, so Sonnet silently falls back to Anthropic's Claude Platform on AWS but never to
Azure, Vertex, Bedrock, or another upstream. The local parse and the single retry stay regardless.
The provider promise is the optimization; the local parse is the guarantee.

`strict` is off. Strict mode is OpenAI's JSON Schema subset — every property required, no defaults —
and these schemas are not written in it: an omitted `revisedAnswer` and a defaulted `note` both mean
something. Retiring it also removed the two findings that Anthropic's strict mode had raised
(`minLength` from `z.string().min(1)`, and `["string","null"]` type arrays). The class of problem
does not go away, though — every provider takes a different subset — so the four schemas have to
stay inside the common one, and the tests assert against the keywords most likely to fall outside
it. Only a live call catches an unsupported keyword; a unit test only catches a regression.

`cachedPrefix` keeps stable text before the varying tail so any provider-side prompt cache can
recognize a byte-identical prefix. Cache usage is reported in the structured-call metrics rather
than assumed by the application.

When selected, `effort` becomes OpenRouter's `reasoning: { effort }`, which each upstream normalizes
to its own thinking budget or reasoning toggle. `tailorResume` selects `none`: leaving effort absent
still allowed 1.3k–2.3k adaptive reasoning tokens and pushed the call past 20 seconds, while the
structured resume itself measured only 179–330 tokens.

### Live measurements

The previous writing-model benchmark no longer represents current routing. Re-measure latency,
reasoning tokens, cache reads and cost for `anthropic/claude-sonnet-5` before using historical
numbers for capacity or pricing decisions. Every structured call already logs the resolved upstream,
duration, token breakdown and cost needed for that comparison.

The tool's `input_schema` is **derived from that same zod schema** via `zod-to-json-schema` (pinned
exact at 3.24.6 to match the installed zod), with `$refStrategy: 'none'` so the schema stays flat —
Anthropic's `input_schema` doesn't dereference `$ref`/`definitions`. There are no hand-maintained
JSON Schema mirrors anywhere in this package; if one appears, it's a regression.

Every call site goes through this one function, so a change of mechanism is a change to this file
alone — which is how the `strict` and structured-outputs comparison above was made without touching
a single operation.

### `promptContext.ts`

`groundingContext(profile, jobInfo?)` — the `<base_profile>` / `<job_info>` block every writing
prompt opens with, plus the `sanitizeXmlContent` escape that stops injected content breaking out of
it. It is one helper rather than three hand-built copies because each prompt's non-fabrication rule
is phrased as "not present in the base profile": if one call site named that container something
else, the rule would refer to nothing. `jobInfo` is optional, so the Ask tab works with no job page.

### `extractJob.ts`

Takes the candidate-reviewed **Job Description** field (whether manually pasted or
populated by Autofill's focused page extractor), requests the `report_job_info` schema, and returns a
validated `JobInfo`. The prompt deliberately does not describe the input as raw scraped page text;
told that, a model tolerates and mines junk that the extractor is required to reject. It uses Gemini
Flash Lite because this call is the serial gate before resume and answer generation can start; the
schema and local validation bound its output without paying Sonnet latency for extraction.

### `tailorResume.ts`

Takes the Profile's skills/work experience plus `JobInfo`, and returns a validated
`TailoredResume`. Skills are copied from the Profile unchanged and are not part of the model output.
Sonnet 5 runs with reasoning disabled and returns only work-experience source indices plus rewritten
bullet text; post-processing resolves company/title/date metadata from the Profile. Missing,
duplicate, or invalid pointers conservatively fall back to the source role.

### `answerQuestions.ts`

Sonnet 5 call. Takes the answer-writing projection of `Profile` (work experience, education, skills,
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

### `answerChat.ts`

One turn of the Ask tab's conversation about a single application question, through the same
`structuredCall.ts` and the same `groundingContext` grounding as `answerQuestions`. Asking cold and
refining an existing draft are the same function: what separates them is whether `currentAnswer` is
set and whether the thread already has turns, never a "which flow is this" branch.

Two rules are enforced here rather than in the prompt:

- The Profile, the job and the question live in the **scaffold turn**, never in a message the
  candidate can rewrite — a chat is exactly where "just say I led the migration" shows up, and this
  must not become the one surface where the model may invent experience.
- A **cold** turn (no prior messages, no `currentAnswer`) validates against a stricter schema where
  `revisedAnswer` is required. Elsewhere it is optional, because a turn may be purely conversational
  ("which of these two stories do you want?"); on a cold ask a reply with no answer would render an
  Ask tab whose one purpose visibly didn't happen.

The wire schema also requires the thread to alternate and end with the candidate's turn. A leading
user turn is folded into the scaffold rather than sent after it — the Messages API refuses two user
turns in a row — so a malformed thread is a 400 here, not an opaque provider 500.

## `src/pdf/renderResume.tsx`

A single `@react-pdf/renderer` template. Contact info and education come from the
`RenderResumePdfProfile` projection (not job-specific); skills and work experience come from the
`TailoredResume`.

The render **fits itself to one page**: it renders at the researched density, counts pages off the
PDF's own page tree, and re-renders one step tighter down a four-step ladder until it fits. Every
step stays inside a sourced range and no step touches `fontSize` — leading and whitespace are
spendable, legibility is not. Past ~5 roles × 6 bullets it returns two pages with all content rather
than truncating. A profile preference selects A4 or Letter and whether role titles retain the
`Role:` prefix. Noto Sans is embedded for Unicode text, and the final render is parsed back to verify
its size, content, and reading order before any bytes are returned. See
`docs/resume-design-conventions.md` for where the numbers come from.

## `*.test.ts`

LLM modules follow one pattern: `vi.mock('./client.js', () => import('./fakeModel.js'))` swaps the
provider for `fakeModel.ts`, so no test ever calls the real API. Each checks that the prompt carries
the data it should, the happy path, and a clear throw when the model returns something that isn't
the object or one that fails validation.

`fakeModel.ts` is the fake, in the `fakeChrome.ts` mould: one `MockLanguageModelV4` answering from a
shared spy, plus helpers to build a generation and to read the request back. It exists because the
provider contract is not guessable — token counts are grouped rather than flat and a finish reason
is an object — so a plausible hand-rolled response is read as a generation that used no tokens and
stopped for no reason, and a logging assertion then passes for the wrong reason. It fakes the
_provider_, not `callStructured`: schema conversion, validation, the retry and the failure
classification are the behaviour under test, which is what lets the other five assert on real
prompts. Its copy of `MODELS` is deliberate — importing the real one would be a cycle, since this
module _is_ the mock for `client.js` — and the tests that pin a route are what catch a drift.

`renderResume.test.ts` uses no mocking — there's no network involved — and reads the rendered text
back out with `unpdf`, so a layout regression can actually fail a test.

`db/database.integration.test.ts` uses PGlite's PostgreSQL engine to execute the optimized window
query and migrations `0004`–`0006`, including duplicate, empty-table, and index cases.

## `vitest.config.ts`

Same minimal Node-environment config as `packages/shared`.

## `.env.example`

Template for the real `.env` (gitignored): `DATABASE_URL` (Neon connection string),
`OPENROUTER_API_KEY`, `PORT`.

The package has its own `tsconfig.json` and builds JSX with the automatic `react-jsx` runtime. Run
`pnpm --filter backend build` to compile it, `pnpm --filter backend test` for this package's tests,
or `pnpm test` for the whole workspace.
