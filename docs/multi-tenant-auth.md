# Multi-tenant authentication — design and roadmap

> **Status: Phases A–D complete (2026-09-01), email/password only.** Ownership, Better Auth session
> verification, dashboard login, and extension login are all implemented and tested — see the
> checklists below. Google/GitHub OAuth (part of the original Phase B and D plans) is deferred until
> a provider is actually registered; only email/password works today, for one real account. Phases E–F
> (cost control, pre-public hardening) are not started. ADR 0001 (single Cloudflare Worker) is
> explicitly _not_ assumed here.
>
> The file/module names below were corrected on the 2026-09-01 pass — the repo has moved since this
> was written (Phases 12–19 landed in between) and a few names in the original plan no longer exist.
> See the note at the end of _Blast radius_.

## This is two jobs, and the order matters

**Identity in the data model** and **proving who someone is** are separable, and doing them in that
order is what makes this safe:

1. Today nothing in the database has an owner. `profiles` is a hardcoded singleton
   (`PROFILE_ID = '00000000-0000-4000-8000-000000000001'`), and migration `0004` _deliberately
   deleted every row but one_ to get there. `applications` has no owner column at all.
2. So the large, mechanical, easy-to-get-wrong change is adding ownership to every table and every
   query — and it has nothing to do with logging in.

Do that first, with a single bootstrap user id threaded through as a constant. The app behaves
identically, every test still passes, and cross-tenant scoping gets written and reviewed while there
is still exactly one tenant and a mistake cannot leak anything. Auth then becomes one small question:
where does that id come from?

Building it the other way round means the first real second user is also the first test of the
scoping — on live data containing immigration status.

## Mechanism

**An OAuth-first auth library, self-hosted against the existing Neon Postgres.** Better Auth is the
closest fit to this stack (TypeScript, Hono handler, Drizzle adapter); verify its current
integration surface against its own docs before committing to it.

- **Not roll-your-own.** The Profile stores work-authorization, sponsorship and veteran status.
  Password hashing, reset-token expiry and session rotation are the wrong things to own when that is
  the data that leaks.
- **Not a fully external service** (Clerk, Auth0). Every query below is about to grow
  `where user_id = ...`. Keeping `users` in the same database makes ownership a foreign key Postgres
  enforces, rather than a token claim the application has to trust.
- **OAuth-first (Google, GitHub), email/password optional and later.** MV3 cannot hold a client
  secret, so the extension must use `chrome.identity.launchWebAuthFlow` with PKCE against a real
  authorization endpoint. Once that endpoint exists, social login costs almost nothing and skips
  password storage, reset flows and email delivery entirely at v1.

## Decisions

- **`profiles` is keyed _by_ the user.** Drop the separate `profiles.id` and make `user_id` the
  primary key, one profile per user as a schema guarantee rather than a rule to remember. This keeps
  the property migration `0004` was built for: `saveProfile` stays one atomic upsert on the primary
  key.
- **User-scoped indexes are a correctness requirement, not a performance one.** Both existing
  indexes must gain a `user_id` prefix. The Duplicate Guard matches on `job_key`; unscoped, one
  user's saved application suppresses another user's analysis and tells them they already applied to
  a job they have never seen.
- **Another user's row is a 404, never a 403.** `getApplicationById` currently throws on an
  unparseable row precisely because `null` would claim the row doesn't exist. The same care applies
  here in reverse: 403 confirms the id is real and leaks existence. Not-yours and not-there must be
  indistinguishable.
- **Bearer token for the extension, httpOnly cookie for the dashboard.** One middleware accepts
  either. The extension is not a browser page and has no same-site relationship with the backend; the
  dashboard is, and an httpOnly cookie is the strongest thing available to it against XSS.
- **The content-type guard in `app.ts` becomes load-bearing for CSRF.** It exists today as a CSRF
  defense for an unauthenticated local server. Once the dashboard authenticates by cookie it is
  defending real sessions, so it must not be relaxed. Bearer requests are not CSRF-able, since
  nothing attaches the header automatically.
- **Extension tokens live in `chrome.storage.session`, not `storage.local`.** Session storage is
  in-memory, is not written to disk, and is not exposed to content scripts — and it survives service
  worker eviction, which is exactly the property the MV3 durability work already relies on.
  `storage.local` is unencrypted on disk and currently holds only the theme; it should not start
  holding credentials. The cost is re-authenticating when the browser restarts, unless a refresh
  token is kept in `local`, which is a trade to make deliberately rather than by default.
- **The extension needs a stable id.** `launchWebAuthFlow` redirects to
  `https://<extension-id>.chromiumapp.org/`, which must be registered with the OAuth provider. That
  requires pinning the id with a `key` in the manifest; an unpinned dev build gets a new id and a
  redirect the provider rejects.

## Blast radius

| Area                                                        | What changes                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db/schema.ts`                                              | New `users` table; `user_id` on `applications`; `profiles` re-keyed to `user_id`; both indexes gain a `user_id` prefix                                                   |
| `db/profileStore.ts` / `db/postgresProfileStore.ts`         | `ProfileStore.get`/`.save` take a `userId`; `PROFILE_ID` deleted from `postgresProfileStore.ts`; `inMemoryProfileStore` gains the same parameter                         |
| `db/applicationStore.ts` / `db/postgresApplicationStore.ts` | All eight `ApplicationStore` methods take a `userId` and scope on it, in both the Postgres adapter and `inMemoryApplicationStore`                                        |
| `routes/*.ts`                                               | Every handler reads the user from context instead of assuming one                                                                                                        |
| `app.ts`                                                    | Auth middleware, registered after CORS and the content-type guard, before the routes                                                                                     |
| `llm/client.ts`                                             | Module-scope `createOpenRouter()` must become per-request if BYOK is chosen                                                                                              |
| `packages/http-client/src/index.ts`                         | New: a way for a caller to attach a bearer token or request `credentials: 'include'` — `HttpTransportOptions`/`RequestOptions` today carry no auth-related fields at all |
| `extension/lib/callBackend.ts`                              | Passes a token into the shared transport; 401 handling                                                                                                                   |
| `extension/options/`                                        | The login surface, and where a user's own API key would go                                                                                                               |
| `dashboard/lib/dashboardClient.ts`                          | Passes `credentials: 'include'` into the shared transport; 401 handling                                                                                                  |
| `dashboard/lib/useHashRoute.ts`                             | A `#/login` route, and an unauthenticated redirect                                                                                                                       |

**Corrected from the original plan:** both clients now go through one shared package,
`@djobi/http-client` (`createHttpTransport`), not two independent per-app `request()` functions —
that consolidation happened while this doc sat unstarted. This makes the auth wiring _smaller_ than
originally scoped: bearer-token/cookie-credentials support is one change in the shared package's
`RequestOptions`, and `callBackend.ts` / `dashboardClient.ts` each become a one-line caller of it,
rather than two implementations to keep in sync.

## Naming corrections (2026-09-01 pass)

The rest of this document still says `db/profileRepository.ts` and `db/applicationsRepository.ts` in
a few places below — read those as `db/profileStore.ts` + `db/postgresProfileStore.ts` and
`db/applicationStore.ts` + `db/postgresApplicationStore.ts` respectively; the "repository" naming was
never adopted. `applicationStore.contract.test.ts` already runs the same suite against both the
in-memory and a real Postgres (PGlite) adapter — that existing file is where Phase A's
cross-user-isolation tests belong, not a new one. Migration numbering has also moved: the newest
migration in the repo is `0008` (Phase 19), so Phase A's migration is `0009`, not `0007`.

## The thing that will bite you

**One server-side `OPENROUTER_API_KEY` funds every user who signs up.** (Corrected: this was
`ANTHROPIC_API_KEY` when the doc was written; Phase 11 moved the whole backend onto OpenRouter, and
`llm/client.ts` is now a single `createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })`
instance — the module-scope-singleton problem below is unchanged, just under a different name.)
Today that is fine because there is one user. The moment signup is public, an analysis run is three
model calls that someone else pays for, and there is no upper bound. This is not a hardening task to
do later — it gates going public at all.

Two workable answers:

- **Bring your own key.** Each user stores their own OpenRouter key, encrypted at rest. Honest, cost-
  safe, and it makes the `llm/client.ts` refactor mandatory: the module-scope singleton reads the key
  at import time and must become a per-request client. Costs you a worse first-run experience.
- **Hard per-user quotas.** You keep paying, with a counted ceiling per user per period, enforced
  server-side before the call. Better onboarding, real money at risk, and quota accounting is its own
  small system.

Settle this before Phase B. It changes whether `llm/client.ts` is refactored and whether the options
page grows a key field.

## Phases

### Phase A — Ownership in the data model (no auth yet) — done

The whole mechanical change, performed while there is still one tenant.

- [x] Migration `0009` (next free number — `0008` is Phase 19's): create `users`; add
      `applications.user_id` (nullable, then backfilled, then `not null`); re-key `profiles` to
      `user_id` as primary key; recreate both application indexes with a `user_id` prefix
- [x] Backfill: insert one bootstrap user, assign the existing profile row and every existing
      application to it
- [x] `db/profileStore.ts` (interface) + `db/postgresProfileStore.ts` (impl): `ProfileStore.get`/
      `.save` take `userId`; delete `PROFILE_ID`; `inMemoryProfileStore` gains the same parameter
- [x] `db/applicationStore.ts` (interface) + `db/postgresApplicationStore.ts` (impl): all eight
      `ApplicationStore` methods take `userId` and scope on it, in both the Postgres adapter and
      `inMemoryApplicationStore`
- [x] Routes thread a single exported `BOOTSTRAP_USER_ID` constant — one place, easy to grep, and the
      only thing Phase B replaces
- [x] Tests: `applicationStore.contract.test.ts` already runs one suite against both adapters — add a
      **second user** to it whose rows must never appear in the first user's reads. This is the test
      category that matters and it is worth over-covering. Extend `postgresProfileStore.test.ts`
      the same way
- [x] Integration test: the Duplicate Guard does not match across users

### Phase B — Auth provider and session verification — done except social login

- [x] Better Auth mounted on the Hono app (`apps/backend/src/auth.ts`), using the existing Drizzle
      Postgres connection; reconciled with Phase A's `users` table via `user.modelName: 'users'`
- [ ] Google and GitHub providers configured; PKCE public-client flow enabled — **not done.** Only
      Google is wired, and with blank `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (`.env.example`) —
      the app isn't registered in Google Cloud Console yet. GitHub is not configured at all.
      Email/password is what actually works today.
- [x] Auth middleware in `app.ts`, registered **after** CORS and the content-type guard and **before**
      the routes — Hono composes in registration order, and the CORS comment in `app.ts` explains why
      that ordering is not negotiable. Auth routes themselves are exempt
- [x] Middleware accepts an httpOnly session cookie or a `Bearer` token, sets `c.set('userId', ...)`,
      and answers 401 with the existing `BackendErrorBody` shape so both clients' error paths already
      handle it (`authMiddleware.ts`)
- [x] `BOOTSTRAP_USER_ID` no longer read by any route — every handler reads `c.get('userId')` instead.
      The constant itself is kept (not literally deleted): migration `0009`'s backfill and several
      store-level tests still need a concrete, real-looking id — see `db/bootstrapUser.ts`'s own
      comment. **How that bootstrap row acquires a real login is still an open question** — no route
      or script exists yet to give it a password; see the note below on signup.
- [x] Route tests cover: no credential (`authMiddleware.test.ts`), an invalid/garbage credential
      (bearer and cookie), and a valid session mapping to the right `userId`

### Phase C — Dashboard login — done

- [x] `#/login` route (`useHashRoute.ts`'s `LoginRoute`, `loginPath`), and a redirect for any
      unauthenticated view (`App.tsx`'s effect on `unauthorized`)
- [x] `credentials: 'include'` — landed on `@djobi/http-client`'s `HttpTransportOptions` (a
      transport-level default, since every dashboard call needs it) rather than literally inside a
      `dashboardClient.request()`, which doesn't exist as its own function; `dashboardClient.ts`'s
      shared `transport` sets it
- [x] 401 clears local state (`useApplicationStore`'s `unauthorized`/`reload`) and routes to login
      rather than surfacing a generic backend error
- [x] `createFixtureDashboardClient` grows a `FixtureAuthOptions` authenticated-user notion
      (`signedIn`/`email`/`password`), so `App.test.tsx` keeps driving the whole app with nothing
      mocked

**Resolved:** the open question above (how the one real user claims the bootstrap row) was decided
as option (a). `aismatov1991@gmail.com` signed up for real through `/api/auth/sign-up/email`, and a
one-off script reassigned `applications.user_id`/`profiles.user_id` from `BOOTSTRAP_USER_ID` to that
account's real id (200 applications, 1 profile — verified 0 rows left on the bootstrap id
afterward). This also surfaced two bugs the migration to real auth had not yet been tested against,
both now fixed: the pending `0009`/`0010` migrations had never been applied to the live Neon database
(applied), and the dashboard's session cookie was `SameSite=Lax` with no `Secure`, which Chrome
silently drops as a third-party cookie on the cross-origin dashboard↔backend calls — fixed by a
same-origin Vite dev proxy (`apps/dashboard/vite.config.ts`) rather than a cookie-attribute patch.

### Phase D — Extension login — done except OAuth

**Scoped down from the original OAuth/PKCE plan below to email/password**, matching Phase B/C: neither
Google nor GitHub has real credentials configured yet, so `chrome.identity.launchWebAuthFlow` + PKCE
infrastructure couldn't actually be exercised end to end. Better Auth's `bearer()` plugin already
returns the session token via a `set-auth-token` response header on **any** successful sign-in,
credential-based included, so the extension doesn't need OAuth to get a working bearer token. The
OAuth items below are kept as the documented follow-up once a provider is registered, not implemented.

- [x] Pin the extension id with a manifest `key` (`manifest.ts`, `EXTENSION_ID` in
      `extensionConfig.ts`) — needed regardless of OAuth, since Better Auth's `trustedOrigins`
      (`auth.ts`) rejects a POST from an origin it doesn't recognize, `chrome-extension://` included,
      and an unpinned dev build gets a fresh random id every reload
- [ ] Register `https://<extension-id>.chromiumapp.org/` with a provider — deferred with OAuth
- [ ] `identity` permission — not added; not needed for the email/password path, only for
      `launchWebAuthFlow`. The backend origin was already in `host_permissions` since Phase A
- [ ] Sign-in via `chrome.identity.launchWebAuthFlow` with PKCE — deferred; `options/Login.tsx` is an
      email/password form instead, calling `lib/authClient.ts`
- [x] Token in `chrome.storage.session` (`lib/authToken.ts`); `lib/fakeChrome.ts` and
      `fakeSessionStorage.ts` already modeled this, exactly as anticipated
- [x] `callBackend.ts`'s transport attaches the token (`@djobi/http-client`'s new
      `getAuthorization` option, resolved fresh per call); a 401 surfaces as "sign in again" in the
      panel — a new `RunFailureKind: 'unauthorized'`, mapped in `background/pipelineFailure.ts` and
      worded in `panel/AutofillTab.tsx`'s `failureReason` (there is no `BackendError` status branch
      in this codebase to reuse — the doc's original wording assumed one)
- [x] The panel handles signed-out mid-run: a 401 during any step already checkpointed through
      `checkpointFailure` like any other `HttpError` before this phase (`background/runClaim.ts`'s
      generic catch), so this needed only the new failure kind above, not new checkpointing logic

### Phase E — Cost control

- [ ] Whichever of BYOK or quotas was settled above
- [ ] If BYOK: `llm/client.ts` becomes a per-request client; encrypt keys at rest; never return a
      stored key to any client, not even masked to its owner
- [ ] If quotas: server-side counting enforced before the model call, not after

### Phase F — Before it is public

- [ ] Rate limiting on the auth routes and the three model routes
- [ ] CORS allowlist moves from the hardcoded localhost pair to real configured origins
- [ ] The hardcoded `BACKEND_ORIGIN` in `callBackend.ts`, `dashboardClient.ts` and the manifest host
      permission becomes build-time config
- [ ] Account deletion that actually deletes — profile, applications, notes
- [ ] A privacy policy, given what the Profile stores. Required by the Chrome Web Store for an
      extension handling personal data, and true regardless

## Not doing

- **Roles or sharing.** Every row has exactly one owner. There is no reviewer, no team, no shared
  application. Adding an owner column is not the same as adding an authorization model, and this
  should stay the simpler thing until there is a reason.
- **Migrating the singleton away from a real user.** The existing profile becomes the bootstrap
  user's profile. It is real data belonging to a real person.
