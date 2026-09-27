/** The Profile persistence port and its in-memory adapter for tests (see `applicationStore.ts`). */
import type { Profile } from '@djobi/shared';

/**
 * Profile persistence: one Profile per user, keyed by `userId`. `get` answers `null` when none has
 * been saved.
 */
export interface ProfileStore {
  get(userId: string): Promise<Profile | null>;
  /** Inserts or replaces the stored Profile for `userId`, answering with what was written. */
  save(userId: string, profile: Profile): Promise<Profile>;
}

/** A `ProfileStore` in a `Map` keyed by `userId`, for tests. Users never see each other's rows. */
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
