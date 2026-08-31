import { ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import type { ProfileStore } from '../db/profileStore.js';
import { parseBody } from '../requestBody.js';

/**
 * `GET /profile` / `POST /profile` — reads and saves the single stored profile.
 *
 * `store` is a parameter for the reason given in `db/profileStore.ts`: the seam is what lets these
 * two routes run with no database.
 */
export function profileRoute(store: ProfileStore): Hono {
  const route = new Hono();

  route.get('/profile', async (c) => {
    const profile = await store.get();
    return c.json(profile);
  });

  route.post('/profile', async (c) => {
    const parsed = await parseBody(c, ProfileSchema);

    const saved = await store.save(parsed);
    return c.json(saved);
  });

  return route;
}
