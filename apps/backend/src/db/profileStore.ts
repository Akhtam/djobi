/**
 * The backend's view of where the Profile is persisted, and the in-memory adapter its tests run
 * against. The reasoning is `db/applicationStore.ts`'s — this is the same seam for the singleton
 * record.
 */
import type { Profile } from '@djobi/shared';

/**
 * Everything the backend needs from Profile persistence.
 *
 * There is exactly one Profile, so neither method takes an id. `get` answers `null` for a candidate
 * who has not set one up yet — a real answer, not a missing row.
 */
export interface ProfileStore {
  get(): Promise<Profile | null>;
  /** Inserts or replaces the stored Profile, answering with what was written. */
  save(profile: Profile): Promise<Profile>;
}

/** A `ProfileStore` held in a variable, for tests. */
export function inMemoryProfileStore(seed: Profile | null = null): ProfileStore {
  let stored = seed;

  return {
    async get() {
      return stored;
    },
    async save(profile) {
      stored = profile;
      return profile;
    },
  };
}
