import { ProfileSchema, type Profile } from '@djobi/shared';
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { profiles } from './schema.js';

export const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Reads the single stored profile, if one exists.
 *
 * Parsed rather than cast. `data` is jsonb, so a row written before a field was added to
 * {@link ProfileSchema} comes back without it, and `row.data as Profile` asserted a shape the row
 * didn't have — the compiler then vouched for fields that were `undefined` at runtime, and the
 * mismatch surfaced as a `Cannot read properties of undefined` deep inside whatever first touched
 * one. Parsing repairs fields with explicit schema defaults; missing required data still fails here,
 * naming the field instead of surfacing somewhere further downstream.
 */
export async function getProfile(): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, PROFILE_ID));
  if (!row) return null;
  return ProfileSchema.parse(row.data);
}

/**
 * Atomically inserts or updates the singleton row in one database statement.
 */
export async function saveProfile(profile: Profile): Promise<Profile> {
  await db
    .insert(profiles)
    .values({ id: PROFILE_ID, data: profile })
    .onConflictDoUpdate({
      target: profiles.id,
      set: { data: profile, updatedAt: new Date() },
    });

  return profile;
}
