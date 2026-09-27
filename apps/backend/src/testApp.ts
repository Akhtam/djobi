/**
 * The app over in-memory stores and fake auth, for tests only. Returns the stores so tests can
 * seed through the argument and assert on what was stored.
 */
import type { Application, Profile } from '@djobi/shared';
import { createApp } from './app.js';
import { fakeAuth, fakeUnauthenticated } from './authMiddleware.js';
import { inMemoryApplicationStore, type ApplicationStore } from './db/applicationStore.js';
import { BOOTSTRAP_USER_ID } from './db/bootstrapUser.js';
import { inMemoryProfileStore, type ProfileStore } from './db/profileStore.js';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  applicationStore: ApplicationStore;
  profileStore: ProfileStore;
}

/** Seeded rows are owned by `BOOTSTRAP_USER_ID`. */
export interface TestAppSeed {
  applications?: Application[];
  profile?: Profile | null;
  /**
   * Who requests authenticate as (default `BOOTSTRAP_USER_ID`). Use another id to test cross-user
   * access, or `null` for 401 on every request.
   */
  authenticatedAs?: string | null;
}

/**
 * An app over empty in-memory stores, or over the rows, Profile and identity a case seeds it with.
 */
export function createTestApp(seed: TestAppSeed = {}): TestApp {
  const applicationStore = inMemoryApplicationStore(
    (seed.applications ?? []).map((application) => ({ userId: BOOTSTRAP_USER_ID, application })),
  );
  const profileStore = inMemoryProfileStore(
    seed.profile ? new Map([[BOOTSTRAP_USER_ID, seed.profile]]) : new Map(),
  );
  const requireAuth =
    seed.authenticatedAs === null
      ? fakeUnauthenticated()
      : fakeAuth(seed.authenticatedAs ?? BOOTSTRAP_USER_ID);

  return {
    app: createApp({ applicationStore, profileStore, requireAuth }),
    applicationStore,
    profileStore,
  };
}
