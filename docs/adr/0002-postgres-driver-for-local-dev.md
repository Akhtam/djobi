# 2. Connect to Postgres over the plain wire protocol, not Neon's HTTP driver

Date: 2026-09-14

## Status

Accepted, implemented.

## Context

`apps/backend/src/db/client.ts` used `@neondatabase/serverless`'s `neon()` function through
`drizzle-orm/neon-http` — a driver that speaks Neon's proprietary HTTP protocol, not the standard
Postgres wire protocol. ADR-0001 chose it deliberately, for a Cloudflare Worker deploy: Workers
have no raw TCP sockets, so a Worker-hosted backend needs an HTTP-based driver to reach Postgres at
all.

That choice has a cost this project didn't have until now: an HTTP-only driver only works against
Neon (or another host speaking the same proprietary protocol). It cannot open a connection to a
plain local Postgres, a Dockerized one, or any other self-hosted instance — there is no HTTP
endpoint on the other end to call. Every contributor was required to have a Neon account before the
backend would start at all, cloud dependency and all.

This project is being open-sourced. A contributor who clones it and wants to run it — with Docker,
with a Postgres they already have installed, or with neither cloud account nor internet access at
all — is now a real user this backend has to serve, and today it can't.

## Decision

Connect with `pg` (`drizzle-orm/node-postgres`) instead: a connection pool over the standard
Postgres wire protocol. It works unmodified against:

- A local Postgres install
- Postgres in Docker (`docker-compose.yml` at the repo root)
- Neon — its connection string is a completely standard `postgres://` URL; the wire protocol works
  the same way a `psql` connection to Neon does. `pg-connection-string` (which `pg` uses to parse
  `DATABASE_URL`) already honors `?sslmode=require`, which Neon's connection strings carry, so SSL
  is negotiated correctly with no extra configuration on either side.
- Any other Postgres-wire-compatible host (RDS, Supabase, a self-managed server, …)

One driver, one `DATABASE_URL` shape, and the choice of where the data actually lives (a
contributor's laptop, a Docker volume, or Neon's persistent cloud storage) becomes purely an
operational one — which connection string you put in `.env` — rather than a code branch.

## Consequences

**This reverses part of ADR-0001's reasoning, not its topology.** ADR-0001's single-Worker-origin
deploy is still the plan for a real production deploy; this ADR only changes what talks to Postgres
and how. A Worker deploy still cannot open a raw TCP socket, so `pg` as written here will not run
inside one. That is accepted now because:

- The Worker entrypoint doesn't exist yet (ADR-0001's "Known porting items" — no `wrangler` config
  is in the repo). Nothing that runs today is broken by this.
- Open-source local-dev reach — "clone the repo, run it, no cloud account required" — is a nearer
  and more valuable goal right now than a deploy target that isn't built.
- When a Worker entrypoint is eventually written, it is free to special-case an HTTP driver for
  itself (Cloudflare's Hyperdrive, or `@neondatabase/serverless` again, scoped to that one
  entrypoint) without this shared `client.ts` having to carry that complexity for every environment
  that doesn't need it. A dual-driver abstraction in `client.ts` today, before that entrypoint
  exists, would be speculative generality with no second caller to keep it honest.

**`@neondatabase/serverless` is no longer a dependency.** Nothing else in the backend imported it
(verified: `client.ts` and `client.test.ts` were the only two files). `drizzle-kit`'s CLI
(`db:generate`/`db:migrate`) was never coupled to it — it manages its own `pg`-based connection for
migrations regardless of what the app's runtime client uses — so migrations already worked against
a local Postgres before this change and are unaffected by it.

**Verified**, not just typechecked: `pnpm --filter backend test` passes unchanged (376 tests,
`client.test.ts` updated to mock `pg`/`drizzle-orm/node-postgres` instead), and a throwaway local
Postgres instance was migrated with `drizzle-kit migrate` and then queried through the real `db`
client and a real `app.request()` round trip — the same code path a contributor's `docker compose
up -d db` + `pnpm dev:backend` exercises.

## Not doing

- **A `DATABASE_DRIVER` env var or auto-detection to pick between `pg` and `neon-http`.** Considered
  and rejected for now: it buys nothing today (no Worker entrypoint consumes it) at the cost of a
  second driver to keep tested and documented. Revisit if and when a Worker deploy is actually
  built — see "Consequences" above for where that choice would live instead.
