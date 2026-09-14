/**
 * The production `ProfileStore`: Postgres through Drizzle (local, Docker, or a serverless cloud
 * database — see `docs/adr/0002-postgres-driver-for-local-dev.md`). The interface, and the
 * in-memory adapter this is held against, are in `db/profileStore.ts`.
 *
 * Scoped by `userId` (`docs/multi-tenant-auth.md`, Phase A): every caller supplies one, which since
 * Phase B means `routes/profile.ts` reading it off the authenticated request's own context.
 */
import { ProfileSchema, type Profile } from '@djobi/shared';
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import type { ProfileStore } from './profileStore.js';
import { profiles } from './schema.js';

/**
 * Reads the stored profile for `userId`, if one exists.
 *
 * Parsed rather than cast. `data` is jsonb, so a row written before a field was added to
 * {@link ProfileSchema} comes back without it, and `row.data as Profile` asserted a shape the row
 * didn't have — the compiler then vouched for fields that were `undefined` at runtime, and the
 * mismatch surfaced as a `Cannot read properties of undefined` deep inside whatever first touched
 * one. Parsing repairs fields with explicit schema defaults; missing required data still fails here,
 * naming the field instead of surfacing somewhere further downstream.
 */
async function getProfile(userId: string): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!row) return null;
  return ProfileSchema.parse(row.data);
}

/**
 * Atomically inserts or updates `userId`'s row in one database statement.
 */
async function saveProfile(userId: string, profile: Profile): Promise<Profile> {
  await db
    .insert(profiles)
    .values({ userId, data: profile })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: { data: profile, updatedAt: new Date() },
    });

  return profile;
}

export const postgresProfileStore: ProfileStore = {
  get: getProfile,
  save: saveProfile,
};
