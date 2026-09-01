/**
 * One-time operator step for a database that predates Phase B's multi-tenant auth: reassigns the
 * single Profile and every Application that migration `0009` parked under `BOOTSTRAP_USER_ID`
 * (`db/bootstrapUser.ts`) to a real Better Auth user.
 *
 * Without this, that data is orphaned the moment real sign-up ships: Better Auth mints a fresh
 * random `uuid` for every account it creates (`schema.ts`'s `users.id`, `.defaultRandom()`), which
 * never equals `BOOTSTRAP_USER_ID`, so the first real login sees zero applications and a null
 * profile with nothing in the app itself able to recover them.
 *
 * Run once, after creating the real account (so its row exists in `users`) and before relying on
 * it day to day: `pnpm --filter backend claim-bootstrap-data <email>`.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { applications, profiles, users } from '../src/db/schema.js';
import { BOOTSTRAP_USER_ID } from '../src/db/bootstrapUser.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: pnpm --filter backend claim-bootstrap-data <email>');
  process.exit(1);
}

const [target] = await db.select().from(users).where(eq(users.email, email));
if (!target) {
  console.error(`No user found with email ${email}. Sign up first, then run this.`);
  process.exit(1);
}
if (target.id === BOOTSTRAP_USER_ID) {
  console.error('That account already owns the bootstrap data — nothing to do.');
  process.exit(1);
}

const { rowCount: applicationCount } = await db
  .update(applications)
  .set({ userId: target.id })
  .where(eq(applications.userId, BOOTSTRAP_USER_ID));

const [bootstrapProfile] = await db
  .select()
  .from(profiles)
  .where(eq(profiles.userId, BOOTSTRAP_USER_ID));

let claimedProfile = false;
if (bootstrapProfile) {
  await db.delete(profiles).where(eq(profiles.userId, BOOTSTRAP_USER_ID));
  await db.insert(profiles).values({ userId: target.id, data: bootstrapProfile.data });
  claimedProfile = true;
}

console.log(
  `Reassigned ${applicationCount ?? 0} application(s)${claimedProfile ? ' and the profile' : ' (no profile row existed)'} from the bootstrap user to ${email} (${target.id}).`,
);
