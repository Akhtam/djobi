/**
 * The one user Phase A's ownership migration creates and every existing row is assigned to — see
 * `docs/multi-tenant-auth.md`. Every store call and route that needs a `userId` uses this constant
 * until Phase B adds a real auth provider; that phase is what deletes it, replacing every reference
 * with the id read off an authenticated request.
 *
 * Reuses the value `postgresProfileStore.ts` used as `PROFILE_ID` before this migration, rather than
 * minting a fresh one: it is already the one real profile's identity, and renumbering it would gain
 * nothing.
 */
export const BOOTSTRAP_USER_ID = '00000000-0000-4000-8000-000000000001';
