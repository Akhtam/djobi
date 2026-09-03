# 1. Deploy dashboard and API as a single Cloudflare Worker

Date: 2026-08-20

**Status: Superseded (as of 2026-09-03).** No `wrangler`/Cloudflare config exists in the repo, and
the backend's actual production build is a plain-Node server (`pnpm --filter backend build` emits
`dist/`, started via `node dist/index.js` — see `apps/backend/README.md` and `PROGRESS.md`'s
`apps/backend` entry), not a Worker. `docs/multi-tenant-auth.md` now states outright that this ADR
"is explicitly _not_ assumed" by the live multi-tenant/auth design. The body below is kept as a
historical record of the original decision, not current architecture.

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

1. **Module-scope Anthropic client.** `apps/backend/src/llm/client.ts` does
   `export const anthropic = new Anthropic()` at module scope, reading `ANTHROPIC_API_KEY` at import
   time. Workers evaluate module scope on cold start, where bindings aren't reliably available.
   Reuse the lazy `Proxy` pattern already written and documented in `apps/backend/src/db/client.ts`,
   which solves exactly this problem for `DATABASE_URL`.
2. **PDF rendering needs `nodejs_compat`.** `apps/backend/src/pdf/renderResume.tsx` uses
   `renderToBuffer` from `@react-pdf/renderer`, which returns a Node `Buffer`, resolves packaged Noto
   Sans font files at runtime, and parses the result through `unpdf`. This requires a real workerd
   smoke test rather than assuming Node compatibility is sufficient.
3. **Hardcoded origins** to replace with build-time config:
   `apps/dashboard/src/lib/dashboardClient.ts`, `apps/extension/src/lib/callBackend.ts`, and the
   host permission in `apps/extension/src/manifest.ts`. The extension is not deployed, but it must
   learn the deployed origin.

### Tooling constraint

`wrangler` bundles `workerd`, itself a per-platform native binary shipped as optional dependencies
(`@cloudflare/workerd-darwin-arm64`, `workerd-linux-64`, …). Run `wrangler dev` on the same machine
that installed `node_modules` — a tree installed on one OS does not carry the native binaries for
another.

Note also that only `wrangler dev`, which runs workerd locally, can validate Workers compatibility.
A plain Node environment provides the full Node API surface, so it would happily run both porting
items above that workerd may reject.
