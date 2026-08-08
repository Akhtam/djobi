import type { Profile } from '@djobi/shared';
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { profiles } from './schema.js';

/**
 * Reads the single stored profile, if one exists. Single-user tool for v1 — there's exactly one
 * `profiles` row, so this always reads the first (and only) one rather than taking an id.
 */
export async function getProfile(): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).limit(1);
  if (!row) return null;
  return row.data as Profile;
}

/**
 * Upserts the single stored profile: updates the existing row if one exists, otherwise inserts
 * the first one.
 */
export async function saveProfile(profile: Profile): Promise<Profile> {
  const [existing] = await db.select().from(profiles).limit(1);

  if (existing) {
    await db
      .update(profiles)
      .set({ data: profile, updatedAt: new Date() })
      .where(eq(profiles.id, existing.id));
  } else {
    await db.insert(profiles).values({ data: profile });
  }

  return profile;
}
