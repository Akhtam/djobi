/**
 * The deployed origins this backend trusts, beyond the local-dev pair each allowlist hardcodes.
 *
 * Two allowlists read `PUBLIC_ORIGINS` — `app.ts`'s CORS `origin` (the browser's own check) and
 * `auth.ts`'s `trustedOrigins` (Better Auth's, which runs before any route). Both parsed the
 * variable inline, with the comment on each saying the two must not drift apart; this is that
 * statement made structural rather than repeated.
 *
 * It also fixes what both copies got wrong. `.env.example` ships `PUBLIC_ORIGINS=` — set, and
 * empty — so `process.env.PUBLIC_ORIGINS` is `''`, which is not `undefined`, so the `?? []` fallback
 * never fired and `''.split(',')` put an empty string into both allowlists. Neither matcher happens
 * to accept `''` today, so nothing is known to be exploitable through it; an empty entry in an
 * origin allowlist is still not something to leave to the matcher's discretion.
 */
export function publicOrigins(): string[] {
  return (process.env.PUBLIC_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
