/**
 * The app, built over in-memory persistence and a fake auth check, for tests. Not imported by
 * anything that ships.
 *
 * Every route test needs the same thing: an app whose stores it can seed and read back. Before the
 * persistence seam existed, each one built that with `vi.mock` over a store module and a factory
 * restating its full export surface — five copies of one setup, and the copies had already drifted
 * (two of the five mocked stores nothing under test ever called, purely to stop an import failing).
 *
 * The stores are returned alongside the app because a test's assertions are usually about what was
 * *stored*, not only about what was answered. Seed through the argument, assert through the returned
 * store, and no case has to know that persistence is a `Map`.
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

/**
 * Seeded rows are always owned by `BOOTSTRAP_USER_ID` — Phase A's migration already assigned every
 * pre-existing row to it, and reusing it as "some real user" here needs no arbitrary id of its own.
 */
export interface TestAppSeed {
  applications?: Application[];
  profile?: Profile | null;
  /**
   * Who the *request* authenticates as — independent of who owns the seeded rows above. Defaults to
   * `BOOTSTRAP_USER_ID`, so the vast majority of route tests, which have nothing to do with auth
   * itself, don't have to think about it. Pass a different id to authenticate as someone who does
   * **not** own the seeded rows — the route-layer half of cross-user coverage, on top of what
   * `applicationStore.contract.test.ts` already asserts at the store layer. Pass `null` for the
   * no-credential case: every request gets a 401 with no real session ever involved.
   */
  authenticatedAs?: string | null;
}

/** An app over empty in-memory stores, or over the rows, Profile and identity a case seeds it with. */
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
