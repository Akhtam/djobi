/**
 * The production `ProfileStore` (interface and in-memory twin in `profileStore.ts`), scoped by
 * `userId`.
 */
import { ProfileSchema, type Profile } from '@djobi/shared';
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import type { ProfileStore } from './profileStore.js';
import { profiles } from './schema.js';

/**
 * The stored Profile for `userId`, or `null`. Parsed, not cast: older jsonb gets explicit schema
 * defaults, and missing required data fails here, naming the field.
 */
async function getProfile(userId: string): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!row) return null;
  return ProfileSchema.parse(row.data);
}

/** Inserts or updates `userId`'s row in one statement. */
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
