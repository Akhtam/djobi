# Multi-tenant authentication — design and roadmap

> **Status: proposed, not started (2026-08-25).** No code exists yet. This records the decisions and
> the order to build in. ADR 0001 (single Cloudflare Worker) is explicitly _not_ assumed here.

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

| Area                               | What changes                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `db/schema.ts`                     | New `users` table; `user_id` on `applications`; `profiles` re-keyed to `user_id`; both indexes gain a `user_id` prefix |
| `db/profileRepository.ts`          | `getProfile(userId)` / `saveProfile(userId, profile)`; `PROFILE_ID` deleted                                            |
| `db/applicationsRepository.ts`     | All eight exported functions take a `userId` and scope on it                                                           |
| `routes/*.ts`                      | Every handler reads the user from context instead of assuming one                                                      |
| `app.ts`                           | Auth middleware, registered after CORS and the content-type guard, before the routes                                   |
| `llm/client.ts`                    | Module-scope `new Anthropic()` must become per-request if BYOK is chosen                                               |
| `extension/lib/callBackend.ts`     | One line in `request()` attaches the token; 401 handling                                                               |
| `extension/options/`               | The login surface, and where a user's own API key would go                                                             |
| `dashboard/lib/dashboardClient.ts` | One line in `request()` sets `credentials: 'include'`; 401 handling                                                    |
| `dashboard/lib/useHashRoute.ts`    | A `#/login` route, and an unauthenticated redirect                                                                     |

Both clients have exactly one transport chokepoint, which is why the client-side change is small:
`request()` in `callBackend.ts` feeds both `callBackend` and `callBackendBinary`, and `request()` in
`dashboardClient.ts` feeds both `request` and `send`.

## The thing that will bite you

**One server-side `ANTHROPIC_API_KEY` funds every user who signs up.** Today that is fine because
there is one user. The moment signup is public, an analysis run is three model calls that someone
else pays for, and there is no upper bound. This is not a hardening task to do later — it gates
going public at all.

Two workable answers:

- **Bring your own key.** Each user stores their own Anthropic key, encrypted at rest. Honest, cost-
  safe, and it makes the `llm/client.ts` refactor mandatory: the module-scope singleton reads the key
  at import time and must become a per-request client. Costs you a worse first-run experience.
- **Hard per-user quotas.** You keep paying, with a counted ceiling per user per period, enforced
  server-side before the call. Better onboarding, real money at risk, and quota accounting is its own
  small system.

Settle this before Phase B. It changes whether `llm/client.ts` is refactored and whether the options
page grows a key field.

## Phases

### Phase A — Ownership in the data model (no auth yet)

The whole mechanical change, performed while there is still one tenant.

- [ ] Migration `0007`: create `users`; add `applications.user_id` (nullable, then backfilled, then
      `not null`); re-key `profiles` to `user_id` as primary key; recreate both application indexes
      with a `user_id` prefix
- [ ] Backfill: insert one bootstrap user, assign the existing profile row and every existing
      application to it
- [ ] `profileRepository` and `applicationsRepository`: every function takes `userId` and scopes on
      it; delete `PROFILE_ID`
- [ ] Routes thread a single exported `BOOTSTRAP_USER_ID` constant — one place, easy to grep, and the
      only thing Phase B replaces
- [ ] Tests: every repository test gains a **second user** whose rows must never appear. This is the
      test category that matters and it is worth over-covering
- [ ] Integration test: the Duplicate Guard does not match across users

### Phase B — Auth provider and session verification

- [ ] Better Auth (or the chosen equivalent) mounted on the Hono app, using the existing Drizzle
      Postgres connection; reconcile its user table with Phase A's
- [ ] Google and GitHub providers configured; PKCE public-client flow enabled
- [ ] Auth middleware in `app.ts`, registered **after** CORS and the content-type guard and **before**
      the routes — Hono composes in registration order, and the CORS comment in `app.ts` explains why
      that ordering is not negotiable. Auth routes themselves are exempt
- [ ] Middleware accepts an httpOnly session cookie or a `Bearer` token, sets `c.set('userId', ...)`,
      and answers 401 with the existing `BackendErrorBody` shape so both clients' error paths already
      handle it
- [ ] `BOOTSTRAP_USER_ID` deleted; routes read the user from context
- [ ] Route tests cover: no credential, expired credential, and another user's id in the path

### Phase C — Dashboard login

- [ ] `#/login` route, and a redirect for any unauthenticated view
- [ ] `credentials: 'include'` in `dashboardClient.request()`
- [ ] 401 clears local state and routes to login rather than surfacing a generic backend error
- [ ] `createFixtureDashboardClient` grows an authenticated-user notion, so `App.test.tsx` keeps
      driving the whole app with nothing mocked

### Phase D — Extension login

- [ ] Pin the extension id with a manifest `key`; register
      `https://<extension-id>.chromiumapp.org/` with both providers
- [ ] `identity` permission; the deployed backend origin added to `host_permissions`
- [ ] Sign-in on the options page via `chrome.identity.launchWebAuthFlow` with PKCE
- [ ] Token in `chrome.storage.session`; `lib/fakeChrome.ts` and `fakeSessionStorage.ts` already
      model this, so the test seam exists
- [ ] `callBackend.request()` attaches the token; a 401 clears it and surfaces "sign in again" in the
      panel, reusing the existing `BackendError` status branch
- [ ] The panel must handle signed-out mid-run: a 401 during the Analysis Step is a normal step
      failure and should checkpoint through `checkpointFailure` like any other

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
