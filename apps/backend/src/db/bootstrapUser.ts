/**
 * The one user Phase A's ownership migration created and assigned every pre-existing row to — see
 * `docs/multi-tenant-auth.md`. No route reads this constant any more: Phase B's `requireAuth`
 * middleware supplies a real `userId` from context instead (`app.ts`, `authMiddleware.ts`).
 *
 * Kept because it names the historical row inserted by migration `0009`, and because `testApp.ts`
 * and the store-level tests (`applicationStore.contract.test.ts`, `database.integration.test.ts`,
 * `postgresProfileStore.test.ts`) need a concrete, real-looking user id to seed and assert against.
 * The production profile and applications have already been reassigned to the real Better Auth
 * account; no runtime route or operator script uses this id.
 *
 * Reuses the value `postgresProfileStore.ts` used as `PROFILE_ID` before Phase A's migration, rather
 * than minting a fresh one: it is already the one real profile's identity, and renumbering it would
 * gain nothing.
 */
export const BOOTSTRAP_USER_ID = '00000000-0000-4000-8000-000000000001';
