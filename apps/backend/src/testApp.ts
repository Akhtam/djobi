/**
 * The app, built over in-memory persistence, for tests. Not imported by anything that ships.
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
import { inMemoryApplicationStore, type ApplicationStore } from './db/applicationStore.js';
import { inMemoryProfileStore, type ProfileStore } from './db/profileStore.js';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  applicationStore: ApplicationStore;
  profileStore: ProfileStore;
}

/** An app over empty in-memory stores, or over the rows and Profile a case seeds it with. */
export function createTestApp(
  seed: { applications?: Application[]; profile?: Profile | null } = {},
): TestApp {
  const applicationStore = inMemoryApplicationStore(seed.applications ?? []);
  const profileStore = inMemoryProfileStore(seed.profile ?? null);

  return { app: createApp({ applicationStore, profileStore }), applicationStore, profileStore };
}
