/**
 * The backend's view of where the Profile is persisted, and the in-memory adapter its tests run
 * against. The reasoning is `db/applicationStore.ts`'s — this is the same seam for the per-user
 * record.
 */
import type { Profile } from '@djobi/shared';

/**
 * Everything the backend needs from Profile persistence.
 *
 * There is exactly one Profile per user, so both methods take a `userId` rather than a Profile id —
 * see `docs/multi-tenant-auth.md`. `get` answers `null` for a candidate who has not set one up yet, or
 * whose id has none, either being a real answer rather than a missing row.
 */
export interface ProfileStore {
  get(userId: string): Promise<Profile | null>;
  /** Inserts or replaces the stored Profile for `userId`, answering with what was written. */
  save(userId: string, profile: Profile): Promise<Profile>;
}

/**
 * A `ProfileStore` held in a `Map` keyed by `userId`, for tests. One user's `save` must never be
 * visible to another's `get` — the property `postgresProfileStore.test.ts` asserts against the real
 * adapter's query shape, and the property this fake exists to agree with it about.
 */
export function inMemoryProfileStore(seed: Map<string, Profile> = new Map()): ProfileStore {
  const stored = new Map(seed);

  return {
    async get(userId) {
      return stored.get(userId) ?? null;
    },
    async save(userId, profile) {
      stored.set(userId, profile);
      return profile;
    },
  };
}
