/**
 * Deployed origins from `PUBLIC_ORIGINS` (comma-separated), shared by `app.ts`'s CORS list and
 * `auth.ts`'s `trustedOrigins` so they can't drift. Blank entries are dropped — `.env.example`
 * ships `PUBLIC_ORIGINS=`, which would otherwise add `''`.
 */
export function publicOrigins(): string[] {
  return (process.env.PUBLIC_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
