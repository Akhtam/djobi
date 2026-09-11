# 1. Deploy dashboard and API as a single Cloudflare Worker

Date: 2026-08-20

**Status: Accepted, partially implemented (as of 2026-09-04).** This ADR was briefly marked
Superseded on 2026-09-03 on the grounds that no `wrangler` config existed and the backend built as a
plain-Node server. That reading was wrong about where the code was actually heading: the dashboard
had already been changed to call **relative** paths (`apps/dashboard/src/lib/dashboardClient.ts`
sets `baseUrl: ''`), with `vite.config.ts`'s dev proxy standing in for the same-origin deployment
this ADR describes. The dashboard therefore _requires_ the single-origin topology below; it is not
optional. `docs/multi-tenant-auth.md`'s line that this ADR "is explicitly _not_ assumed" contradicts
that and should be read as stale.

Still true: there is no `wrangler` config in the repo, and `pnpm --filter backend build` still emits
a plain-Node `dist/` started with `node dist/index.js`. The Worker entrypoint and `wrangler.jsonc`
remain to be written — see "Known porting items" below for what is now done and what is left.

## Status

Accepted — decided, not yet implemented.

## Context

The dashboard (`apps/dashboard`, a Vite React SPA) and the backend (`apps/backend`, Hono) currently
run as two local dev servers on `127.0.0.1:5174` and `127.0.0.1:5391`. Deploying them to Cloudflare
means choosing between one origin and two.

The backend turns out to be unusually close to Workers-ready already, which shapes the decision:

- Backend source imports **zero** `node:` builtins.
- `@neondatabase/serverless` is the HTTP driver, not a pooled `pg` connection — the shape Workers
  require. `apps/backend/src/db/client.ts` documents this choice.
- `apps/backend/src/app.ts` is a plain Hono fetch handler, deliberately separated from the
  `serve()` call in `apps/backend/src/index.ts` so tests can drive it via `app.request()` without
  binding a port.

## Decision

Deploy both as **one Worker on one origin**:

- A static-assets binding serves `apps/dashboard/dist` with
  `not_found_handling: single-page-application`.
- `/api/*` routes to the existing Hono app.

The Worker entrypoint is additive — `export default app` — and `apps/backend/src/index.ts` stays as
the local Node dev server for the macOS host.

## Consequences

Same-origin means the CORS middleware in `apps/backend/src/app.ts` becomes a **dev-only** concern
rather than a production security boundary. Its current doc comment explains why the origin
allowlist is load-bearing against a page reaching `127.0.0.1`; that reasoning still applies locally,
but not to the deployed Worker. One deploy, one URL, no preflights.

### Known porting items

1. ~~**Module-scope LLM client.**~~ **Done (2026-09-11).** `apps/backend/src/llm/client.ts` used to
   do `export const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })` at
   module scope, reading the key at import time. (This item originally named `new Anthropic()`; the
   provider changed, the hazard did not.) Workers evaluate module scope on cold start, where
   bindings aren't reliably available — the same hazard `apps/backend/src/db/client.ts`'s lazy
   `Proxy` exists to avoid for `DATABASE_URL`.

   `openrouter` is now that same lazy `Proxy`, resolved on first use rather than at import — but the
   key lookup itself is an injected resolver (`configureOpenRouterKey`), not a hardcoded
   `process.env` read, because closing this item exposed a second, narrower claim underneath the
   first one. **Avoiding module-scope binding access** (the hazard above) is not the same claim as
   **avoiding a dependence on the `process.env` compatibility bridge**: Workers can read `env`
   through `process.env` when `nodejs_compat` and a recent compatibility date are both set, but
   nothing in this repository's tree sets them — there is no `wrangler.toml` yet. Copying the
   `Proxy` verbatim would have fixed the first hazard while quietly taking on the second as an
   unstated dependency. `index.ts` calls `configureOpenRouterKey(() => process.env.OPENROUTER_API_KEY)`
   explicitly instead, so the deployed Worker entrypoint this ADR describes can call the same
   function with its own `env.OPENROUTER_API_KEY` lookup when it exists, rather than inheriting a
   Node-only default it never opted into.

   A workerd/Wrangler smoke test for this — the way porting item 2 below was actually verified — is
   still open, and can't run until a `wrangler.toml` exists to run it against.

2. ~~**PDF rendering needs `nodejs_compat`.**~~ **Done (2026-09-04) — and it needed a renderer
   change, not a compatibility flag.** The workerd smoke test this item asked for was run, and
   `@react-pdf/renderer` failed it three separate ways: `createRequire(import.meta.url)` at module
   scope in `renderResume.tsx` threw on evaluation and took down the _entire_ Worker (not just this
   route); its Node build's `renderToBuffer` needs `fs`/streams while wrangler resolves its browser
   build, whose `renderToBuffer` throws by design; and underneath both, its Yoga layout engine ships
   as base64-inlined WebAssembly that instantiates at runtime, which workerd refuses outright
   (`Wasm code generation disallowed by embedder`). Extracting Yoga's `.wasm` and feeding it through
   Emscripten's `instantiateWasm` hook got past instantiation and then hung.

   The renderer was rewritten on `@libpdf/core` — pure JavaScript, no WebAssembly, no `node:`
   imports — with the fonts inlined as base64 (`src/pdf/notoSansFonts.ts`) instead of resolved from
   disk. Verified rendering a Cyrillic resume in `wrangler dev` in ~19 ms. `unpdf`, which preflight
   and resume parsing both use, was smoke-tested on workerd separately and works unchanged.

3. ~~**Hardcoded origins** to replace with build-time config.~~ **Done.** Both clients read
   `VITE_BACKEND_ORIGIN` at build time — `apps/dashboard/src/lib/dashboardClient.ts` (which then
   deliberately uses a _relative_ base, see the status note above) and
   `apps/extension/src/extensionConfig.ts`, whose `EXTENSION_BACKEND_ORIGIN` also feeds the host
   permission in `apps/extension/src/manifest.ts`. The extension still has to be rebuilt and
   repackaged against the deployed origin.
4. ~~**Bundle size.**~~ **Done (2026-09-04).** The whole backend bundles for Workers at **8.83 MB
   raw / 1.87 MB gzip** (`wrangler deploy --dry-run`), inside both the 10 MB gzip paid limit and the
   3 MB free one. The fonts were the largest single input at 1.64 MB; subsetting them at generation
   time to the scripts the product actually renders (`scripts/generateFonts.mts`) cut their gzipped
   contribution from 749 KB to 253 KB and brought the bundle back to what it measured _before_ the
   renderer change (1.87 MB then, 1.87 MB now) — while now actually running.

   Those figures predate adding the combining-mark range to the subset (U+0300–U+036F, needed for
   decomposed accents — see `scripts/generateFonts.mts`). Measured by gzipping the generated module
   either way, the range costs **+65 KB raw / +31 KB gzip**, so the bundle is now ≈1.90 MB gzip
   rather than 1.87 MB — unchanged against both limits. The whole-bundle numbers above have not
   been re-run through `wrangler deploy --dry-run` since; treat them as 30 KB light.

   For anyone tempted to squeeze further: measured by package, the remaining large inputs are
   `unpdf` (1.58 MB minified — pdf.js, needed to parse arbitrary uploaded resumes, not just our own
   output), `@libpdf/core` (488 KB), `zod` (391 KB) and `pkijs` (293 KB, pulled in by
   `@libpdf/core`'s digital-signature support, which this backend never uses — it is not
   tree-shakeable today because the package exposes only a single `.` export).

### Tooling constraint

`wrangler` bundles `workerd`, itself a per-platform native binary shipped as optional dependencies
(`@cloudflare/workerd-darwin-arm64`, `workerd-linux-64`, …). Run `wrangler dev` on the same machine
that installed `node_modules` — a tree installed on one OS does not carry the native binaries for
another.

Note also that only `wrangler dev`, which runs workerd locally, can validate Workers compatibility.
A plain Node environment provides the full Node API surface, so it would happily run both porting
items above that workerd may reject.
