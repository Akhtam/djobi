/**
 * The Better Auth instance: email/password plus Google, on the shared Drizzle/Postgres connection.
 * `user.modelName: 'users'` reuses the existing `users` table; `session`/`account`/`verification`
 * are Better Auth's own.
 *
 * Lazily constructed behind a `Proxy` (like `db/client.ts`): `drizzleAdapter` touches `db` on
 * construction, which would force `DATABASE_URL` at import time and break env-less route tests.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { db } from './db/client.js';
import { publicOrigins } from './publicOrigins.js';
import * as schema from './db/schema.js';

// Named function typed by its return value: `ReturnType<typeof betterAuth>` without these options
// resolves to a wider type the instance isn't assignable to.
function createAuth() {
  // Better Auth silently uses a well-known default key when `secret` is falsy (including the empty
  // `.env.example` value), making sessions forgeable. Fail loudly instead.
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
    // Signs session tokens and cookies.
    secret: process.env.BETTER_AUTH_SECRET,
    // Silences "Base URL is not set"; matches this backend's own default port (`index.ts`,
    // `.env.example`).
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:5391',
    // Origins Better Auth accepts (its own CSRF check, bearer requests included): the dashboard's
    // dev origins, the extension (whose id is pinned by `manifest.ts`'s `key`), and any
    // `PUBLIC_ORIGINS` — parsed by the same `publicOrigins()` as `app.ts`'s CORS list.
    trustedOrigins: [
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'chrome-extension://fgfmcenbbggfhbddflgfoehjahnbimkg',
      ...publicOrigins(),
    ],
    // Better Auth's default ids are base62 strings; its tables use `uuid` columns like the rest.
    advanced: {
      database: {
        generateId: 'uuid',
      },
      // Dev: the Vite proxy makes the dashboard same-origin, so Better Auth's default `Lax` works,
      // and `Secure` stays off because Safari won't store it over `http://localhost`.
      // Production: the dashboard may be a different origin (`PUBLIC_ORIGINS`), so cookies need
      // `SameSite=None`, which browsers only accept with `Secure`. Gated on `NODE_ENV`, not
      // `PUBLIC_ORIGINS`, so tests and local dev stay on plain `http`.
      defaultCookieAttributes: {
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        secure: process.env.NODE_ENV === 'production',
      },
    },
    user: {
      modelName: 'users',
    },
    // Better Auth's built-in limiter, enabled by its own default (production only — tests sign in
    // repeatedly). Sign-in/up already get a stricter built-in rule; not overridden, since a custom
    // rule would replace it. The store is in-memory: fine for one process, needs a shared store if
    // this ever runs as several instances.
    rateLimit: {
      window: 60,
      max: 100,
    },
    // No explicit policy before this was silently "whatever Better Auth defaults to." Stated here
    // so it's a reviewed decision: a week-long session with a daily rolling renewal on activity.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    emailAndPassword: {
      enabled: true,
      // No email provider yet, so addresses aren't verified; enabling this without one breaks
      // sign-up.
      requireEmailVerification: false,
      // Pinned so an upgrade can't loosen it; mirrored by `SignUpRequestSchema` client-side.
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
    // Lets `auth.api.getSession` accept `Authorization: Bearer` — the extension has no cookie.
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
