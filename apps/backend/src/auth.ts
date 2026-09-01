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
    trustedOrigins: [
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'chrome-extension://fgfmcenbbggfhbddflgfoehjahnbimkg',
    ],
    // Better Auth's own default id is a random base62 string, which a `uuid` column rejects outright
    // — every table it owns (`users`, `session`, `account`, `verification`) is `uuid` in
    // `db/schema.ts`, matching the rest of this schema rather than switching those to `text`.
    advanced: {
      database: {
        generateId: 'uuid',
      },
      // `vite.config.ts`'s dev-server `proxy` makes the dashboard same-origin with this backend (see
      // `dashboardClient.ts`'s `transport` comment), so the session cookie is same-site and Better
      // Auth's own default (`SameSite=Lax`) is sent back on every `fetch` without an override.
      // `Secure` is left off deliberately: `localhost`/`127.0.0.1` are secure contexts in Chrome and
      // Firefox even over plain `http`, but Safari refuses to store a `Secure` cookie on an `http://`
      // origin at all — sign-in would 200 and the very next request would 401, the exact symptom the
      // proxy was added to fix. Nothing here forces TLS locally, so this stays correct with none.
      defaultCookieAttributes: {
        sameSite: 'lax',
      },
    },
    user: {
      modelName: 'users',
    },
    emailAndPassword: {
      enabled: true,
      // No email delivery provider wired up yet — a personal-scale tool starting with exactly one
      // account doesn't need one to be useful. Revisit once signup is public
      // (`docs/multi-tenant-auth.md` Phase F already lists the pieces public launch needs).
      requireEmailVerification: false,
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
