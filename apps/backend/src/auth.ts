/**
 * The Better Auth instance — email/password plus Google, backed by the same Drizzle/Postgres
 * connection everything else in this backend uses. See `docs/multi-tenant-auth.md`, Phase B.
 *
 * `user.modelName: 'users'` points Better Auth at the table Phase A already created and
 * `applications`/`profiles` already reference by foreign key, rather than letting it generate a
 * second `user` table of its own — the reconciliation the doc's Phase A section flagged as owed to
 * Phase B. `session`/`account`/`verification` are new tables Better Auth owns outright; nothing
 * existing referenced them before this phase, so there is nothing to reconcile there.
 *
 * Lazily constructed behind a `Proxy`, mirroring `db/client.ts`'s own reasoning exactly:
 * `drizzleAdapter(db, ...)` reads a property off `db` synchronously to introspect the schema, which
 * forces `db/client.ts`'s lazy Proxy to resolve `DATABASE_URL` *at import time* if `betterAuth(...)`
 * were called eagerly here — breaking every route test that imports `app.ts` (which imports this
 * module) without a `.env` file, `auth.test.ts` included until this was caught. Deferring
 * construction to first actual use (a request reaching `/api/auth/*`) keeps that property intact.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { db } from './db/client.js';
import { publicOrigins } from './publicOrigins.js';
import * as schema from './db/schema.js';

// A named function, typed by its own return value, rather than `ReturnType<typeof betterAuth>`
// directly: `betterAuth` is generic over its options, so naming the generic type without applying
// it to this specific literal options object resolves to `Auth<BetterAuthOptions>` — a wider type
// the actual instance below isn't assignable to.
function createAuth() {
  // Better Auth falls back to a well-known default signing key when `secret` is falsy — including
  // the empty string `.env.example` ships for this var — with no warning, which would make every
  // session token forgeable by anyone who knows that default. Fail loudly at first use instead of
  // silently accepting it.
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set. Set it in .env to a random value before starting the backend.',
    );
  }
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    // Signs session tokens and cookies — Better Auth otherwise falls back to an insecure generated
    // one with no warning, which is fine for the one local developer running this today and wrong
    // for the moment this backend is reachable by anyone else (Phase F's "before it is public").
    secret: process.env.BETTER_AUTH_SECRET,
    // Silences "Base URL is not set"; matches this backend's own default port (`index.ts`, `.env.example`).
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:5391',
    // The dashboard's dev origins, plus the extension's — matches `app.ts`'s CORS allowlist for the
    // dashboard. Better Auth checks this itself (its own CSRF defense, independent of `app.ts`'s
    // CORS/content-type guards, and *not* limited to cookie-carrying requests — a bearer-only POST
    // still gets origin-validated) before accepting a request at all.
    //
    // `chrome-extension://fgfmcenbbggfhbddflgfoehjahnbimkg` is the extension's origin, stable only
    // because `manifest.ts` pins its id with a `key` (`docs/multi-tenant-auth.md`, Phase D) — an
    // unpinned dev build gets a fresh random id every reload, which no static allowlist entry could
    // ever match. Without this the extension's sign-in gets a 403 `Invalid origin` before it ever
    // reaches Better Auth's own credential check.
    // `PUBLIC_ORIGINS` (comma-separated, read through `publicOrigins()` — the same parse `app.ts`'s
    // CORS allowlist uses) appends real deployed origins to the local-dev list rather than replacing
    // it, so a production dashboard domain has somewhere to be configured without breaking `pnpm
    // dev`. Unset in dev, where the three origins below are all that's needed.
    trustedOrigins: [
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'chrome-extension://fgfmcenbbggfhbddflgfoehjahnbimkg',
      ...publicOrigins(),
    ],
    // Better Auth's own default id is a random base62 string, which a `uuid` column rejects outright
    // — every table it owns (`users`, `session`, `account`, `verification`) is `uuid` in
    // `db/schema.ts`, matching the rest of this schema rather than switching those to `text`.
    advanced: {
      database: {
        generateId: 'uuid',
      },
      // `vite.config.ts`'s dev-server `proxy` makes the dashboard same-origin with this backend in
      // local dev, so `SameSite=Lax` (Better Auth's own default) is sent back on every `fetch`
      // without an override there. In production the dashboard and this backend are deliberately
      // different origins (`PUBLIC_ORIGINS`), which makes every dashboard `fetch` call a cross-site
      // subresource request — a `Lax` cookie is withheld from those by the browser, so every
      // authenticated request would 401 right after sign-in. `sameSite: 'none'` is required for that
      // topology and is safe only paired with `Secure`, which is also gated on `NODE_ENV ===
      // 'production'` below (browsers reject `SameSite=None` without `Secure`).
      // `Secure` is left off deliberately in dev: `localhost`/`127.0.0.1` are secure contexts in
      // Chrome and Firefox even over plain `http`, but Safari refuses to store a `Secure` cookie on an
      // `http://` origin at all — sign-in would 200 and the very next request would 401, the exact
      // symptom the proxy was added to fix. Nothing here forces TLS locally, so this stays correct
      // with none. `secure: true` only once actually deployed — a real public origin serves this
      // backend over TLS, and a cookie without `Secure` on that origin would still work but travel in
      // the clear. `NODE_ENV` (not `PUBLIC_ORIGINS`) gates this because it must stay off for `pnpm
      // test`/local dev over plain `http://` regardless of what env vars happen to be set.
      defaultCookieAttributes: {
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        secure: process.env.NODE_ENV === 'production',
      },
    },
    user: {
      modelName: 'users',
    },
    // Better Auth's own limiter — no extra dependency needed, and `enabled` is left on Better Auth's
    // own default (on outside test/dev, i.e. effectively `NODE_ENV === 'production'`) rather than
    // forced on here: this backend's own test suite calls `/sign-up/email` and `/sign-in/email`
    // several times in quick succession against one shared in-memory auth instance, which a
    // universally-enabled limiter would start rejecting with 429s that have nothing to do with the
    // behavior under test. Sign-in/sign-up/change-password already get a tighter built-in budget than
    // the general default below once enabled (10s window, 3 requests — see Better Auth's
    // `getDefaultSpecialRules`), which is exactly the credential-stuffing/spam-account protection
    // this needed; not overridden with `customRules` here, since a looser custom rule on those paths
    // would replace that stricter default rather than add to it. The default store is in-memory,
    // which is fine for one backend process and would need a shared store (Redis, or Better Auth's
    // database-backed option) the moment this runs as more than one instance — flagged, not solved
    // here.
    rateLimit: {
      window: 60,
      max: 100,
    },
    // No explicit policy before this was silently "whatever Better Auth defaults to." Stated here so
    // it's a reviewed decision: a week-long session with a daily rolling renewal on activity.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    emailAndPassword: {
      enabled: true,
      // No email delivery provider wired up yet — public signup accepts an unverified address today.
      // Revisit once a provider (Resend/SES/etc.) is chosen; flipping this on with none configured
      // breaks sign-up outright rather than securing it.
      requireEmailVerification: false,
      // Pinned rather than left to Better Auth's own default so a future Better Auth upgrade can't
      // silently loosen it. Mirrored client-side by `SignUpRequestSchema` (`@djobi/shared`) so a
      // too-short password is rejected before the round trip, not just here.
      minPasswordLength: 8,
    },
    socialProviders: {
      google: {
        // Left blank until the app is registered in Google Cloud Console — see `.env.example` for
        // what to fill in and where the redirect URI needs to be registered.
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },
    // `docs/multi-tenant-auth.md`: "Bearer token for the extension, httpOnly cookie for the
    // dashboard." The extension is not a browser page and has no same-site relationship with this
    // backend, so it can't rely on a cookie the way the dashboard can. This plugin is what makes
    // `auth.api.getSession` also accept `Authorization: Bearer <token>`, verified directly in
    // `authMiddleware.test.ts` rather than assumed from the plugin's own docs.
    plugins: [bearer()],
  });
}

type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;

function resolveAuth(): Auth {
  if (!cached) cached = createAuth();
  return cached;
}

export const auth: Auth = new Proxy({} as Auth, {
  get(_target, prop, receiver) {
    return Reflect.get(resolveAuth(), prop, receiver);
  },
});
