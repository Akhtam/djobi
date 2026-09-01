import { ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { BOOTSTRAP_USER_ID } from '../db/bootstrapUser.js';
import type { ProfileStore } from '../db/profileStore.js';
import { parseBody } from '../requestBody.js';

/**
 * `GET /profile` / `POST /profile` — reads and saves the stored profile for the current user.
 *
 * `store` is a parameter for the reason given in `db/profileStore.ts`: the seam is what lets these
 * two routes run with no database.
 *
 * `BOOTSTRAP_USER_ID` stands in for the authenticated request's own id until Phase B
 * (`docs/multi-tenant-auth.md`) adds a real auth provider — this is the one place that constant is
 * used here, so Phase B's edit is confined to this file plus `db/bootstrapUser.ts` itself.
 */
export function profileRoute(store: ProfileStore): Hono {
  const route = new Hono();

  route.get('/profile', async (c) => {
    const profile = await store.get(BOOTSTRAP_USER_ID);
    return c.json(profile);
  });

  route.post('/profile', async (c) => {
    const parsed = await parseBody(c, ProfileSchema);

    const saved = await store.save(BOOTSTRAP_USER_ID, parsed);
    return c.json(saved);
  });

  return route;
}
