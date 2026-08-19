import { ProfileSchema, type Profile } from '@djobi/shared';
import { db } from './client.js';
import { profiles } from './schema.js';

/**
 * Reads the single stored profile, if one exists. Single-user tool for v1 — there's exactly one
 * `profiles` row, so this always reads the first (and only) one rather than taking an id.
 *
 * Parsed rather than cast. `data` is jsonb, so a row written before a field was added to
 * {@link ProfileSchema} comes back without it, and `row.data as Profile` asserted a shape the row
 * didn't have — the compiler then vouched for fields that were `undefined` at runtime, and the
 * mismatch surfaced as a `Cannot read properties of undefined` deep inside whatever first touched
 * one. Parsing applies the schema's defaults, so an older row is upgraded on read; it also means a
 * genuinely malformed row fails here, naming the field, instead of somewhere further downstream.
 */
export async function getProfile(): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).limit(1);
  if (!row) return null;
  return ProfileSchema.parse(row.data);
}

/**
 * Upserts the single stored profile: updates the existing row if one exists, otherwise inserts
 * the first one.
 *
 * The update runs first and reports what it touched, rather than a select deciding which statement
 * to run. Each statement is its own HTTP round trip on Neon's driver, so asking first cost two trips
 * every save; this costs one on the path that always applies after the very first save.
 *
 * The `UPDATE` deliberately carries no `WHERE`. This table holds exactly one row by design — the
 * same premise `getProfile`'s `limit(1)` reads on — so "the existing row" and "every row" are the
 * same set, and there is no id to filter by until after the select this replaces. If a second row
 * ever appeared, writing the profile to both is the outcome that matches what a single-row table
 * means; the previous version left one of them stale and reachable by `getProfile`.
 */
export async function saveProfile(profile: Profile): Promise<Profile> {
  const updated = await db
    .update(profiles)
    .set({ data: profile, updatedAt: new Date() })
    .returning({ id: profiles.id });

  if (updated.length === 0) {
    await db.insert(profiles).values({ data: profile });
  }

  return profile;
}
