# backend

Local Hono server (not yet wired up — see "Not built yet" below) that does the actual LLM and
database work for djobi: extracting structured job info from a scraped posting, tailoring a resume
to it, and drafting answers to freeform application questions. Runs on your machine; the only
cloud dependency is the Neon Postgres database and the Anthropic API itself.

## `src/db/` — persistence (Neon Postgres via Drizzle)

### `schema.ts`

Two tables:

- **`profiles`** — `id`, `updatedAt`, and a single `data` jsonb column holding the entire
  `Profile` object from `@djobi/shared` as one blob (see that package's README for why). No
  migration is needed when `Profile`'s shape changes — `data` just accepts whatever's in it.
- **`applications`** — one row per job you autofill. `company`/`roleTitle`/`jobUrl` are plain
  columns (so they're queryable/filterable without reaching into JSON); `jobInfo`, `tailoredResume`,
  and `answers` are jsonb snapshots of what was generated for that specific application, so past
  applications remain readable even if `Profile` or the tailoring prompt changes later.

### `client.ts`

The Drizzle client used by every route. Reads `DATABASE_URL` from the environment and throws
immediately if it's unset — fails fast at startup rather than on the first query. Uses
`@neondatabase/serverless` + `drizzle-orm/neon-http`, Neon's recommended low-latency driver (a
plain `pg` connection also works if the backend ever needs multi-statement transactions across a
single request).

### `migrations/`

Not created yet — will hold `drizzle-kit generate` output once the schema is finalized and a Neon
project exists to migrate against.

## `drizzle.config.ts`

Config for the `drizzle-kit` CLI (`pnpm db:generate`, `pnpm db:migrate`). Points at `src/db/schema.ts`,
outputs migrations to `src/db/migrations`, and reads `DATABASE_URL` via `dotenv/config` since
drizzle-kit runs outside the app's own env loading.

## `src/llm/` — the three AI calls

### `client.ts`

The `Anthropic` SDK singleton (picks up credentials from `ANTHROPIC_API_KEY` or an `ant auth login`
profile automatically) and the `MODELS` map: `claude-haiku-4-5` for extraction (cheap, high-volume,
purely structured), `claude-sonnet-5` for writing (resume tailoring, question answers — quality
matters more here).

### `structuredCall.ts`

**The one non-obvious file.** The plan called for `client.messages.parse()` +
`zodOutputFormat()` (structured outputs), but the installed `@anthropic-ai/sdk` version (0.68.0)
doesn't have either — no `.parse()` method, no `output_config.format`, no `zodOutputFormat` export.
Rather than pin to a hypothetical newer SDK version, `callStructured()` gets the same effect with
what 0.68.0 actually supports: it forces a single tool call (`tool_choice: {type: "tool", name}`)
with a hand-written JSON Schema `input_schema`, then validates the tool's `input` against the
corresponding zod schema itself (`schema.safeParse`) before returning. If the SDK is upgraded later
and `.parse()`/`zodOutputFormat` become available, the three call sites below are the only things
that would need to change — they all go through this one function.

### `extractJob.ts`

Haiku call. Takes the content script's scraped page text, forces the `report_job_info` tool, and
returns a validated `JobInfo`. The JSON Schema `jobInfoInputSchema` is a hand-maintained mirror of
`JobInfoSchema` from `@djobi/shared` — see `structuredCall.ts` above for why it isn't generated
from the zod schema automatically.

### `tailorResume.ts`

Sonnet call. Takes `Profile` + `JobInfo` (and an optional `priorApplicationsSummary` string —
intended to be a short summary of past `applications` rows for the same company, pulled from
Postgres by the route that calls this, so tailoring doesn't repeat itself word-for-word across
applications to the same employer) and returns a validated `TailoredResume`. The prompt explicitly
forbids inventing experience not present in the base profile.

### `answerQuestions.ts`

Sonnet call. Takes `Profile` (specifically `profile.stories`), `JobInfo`, and a list of
`{fieldId, question}` pairs; returns one `QuestionAnswer` per question, each recording which
`Story.id`s it drew on. Short-circuits to `[]` without calling the API at all when there are no
questions — the popup review UI shouldn't pay for a request when a posting has no freeform fields.

### `*.test.ts`

One test file per LLM function (`extractJob.test.ts`, `tailorResume.test.ts`,
`answerQuestions.test.ts`), all following the same pattern: `vi.mock('./client.js', ...)` replaces
`anthropic.messages.create` with a `vi.fn()` (via `vi.hoisted`, since `vi.mock` factories run before
top-level `const`s), so no test ever calls the real Anthropic API. Each file checks: the right model
and forced `tool_choice` are used, the prompt content includes the data it's supposed to (profile
name, job company, story IDs, etc.), the happy path returns validated data, and the function throws
a clear error when the model doesn't return a tool call or returns one that fails schema validation.

## `vitest.config.ts`

Same minimal Node-environment config as `packages/shared`.

## `.env.example`

Template for the real `.env` (gitignored): `DATABASE_URL` (Neon connection string),
`ANTHROPIC_API_KEY`, `PORT`.

## Not built yet

- `src/index.ts` — the actual Hono app (no server currently starts).
- `src/routes/*.ts` — HTTP endpoints wiring the `llm/*` functions and `db/*` tables together
  (`/extract-job`, `/tailor-resume`, `/answer-questions`, `/render-resume-pdf`, `/profile`,
  `/applications`).
- `src/pdf/renderResume.tsx` — the `@react-pdf/renderer` template.

Run tests for this package with `pnpm --filter backend test`; run both this package's and
`@djobi/shared`'s tests together with `pnpm test` from the repo root.
