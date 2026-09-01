/**
 * The one user Phase A's ownership migration created and assigned every pre-existing row to — see
 * `docs/multi-tenant-auth.md`. No route reads this constant any more: Phase B's `requireAuth`
 * middleware supplies a real `userId` from context instead (`app.ts`, `authMiddleware.ts`).
 *
 * Kept, not deleted, for two reasons. First, it names a real row: migration `0009` actually inserted
 * this id into `users`, and the single profile that existed before Phase B is still that row's —
 * how it gets claimed by a real login is Phase B's own open question (see `db/schema.ts`'s `users`
 * table comment), not something deleting the name would resolve. Second, `testApp.ts` and the
 * store-level tests (`applicationStore.contract.test.ts`, `database.integration.test.ts`,
 * `postgresProfileStore.test.ts`) still need *some* concrete, real-looking user id to seed and
 * assert against — this is that id, not a re-purposed stand-in.
 *
 * Reuses the value `postgresProfileStore.ts` used as `PROFILE_ID` before Phase A's migration, rather
 * than minting a fresh one: it is already the one real profile's identity, and renumbering it would
 * gain nothing.
 */
export const BOOTSTRAP_USER_ID = '00000000-0000-4000-8000-000000000001';
