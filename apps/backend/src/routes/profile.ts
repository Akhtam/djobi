import { ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import type { AuthEnv } from '../authMiddleware.js';
import type { ProfileStore } from '../db/profileStore.js';
import { parseBody } from '../requestBody.js';

/**
 * `GET /profile` / `POST /profile` — reads and saves the stored profile for the current user.
 *
 * `store` is a parameter for the reason given in `db/profileStore.ts`: the seam is what lets these
 * two routes run with no database. `userId` comes from context, set by `app.ts`'s `requireAuth`
 * middleware (real in production, a test double in `testApp.ts`) before either handler runs — Phase
 * B's `docs/multi-tenant-auth.md` replaced the `BOOTSTRAP_USER_ID` constant this file used to read
 * directly with that.
 */
export function profileRoute(store: ProfileStore): Hono<AuthEnv> {
  const route = new Hono<AuthEnv>();

  route.get('/profile', async (c) => {
    const profile = await store.get(c.get('userId'));
    return c.json(profile);
  });

  route.post('/profile', async (c) => {
    const parsed = await parseBody(c, ProfileSchema);

    const saved = await store.save(c.get('userId'), parsed);
    return c.json(saved);
  });

  return route;
}
