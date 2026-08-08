import { ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { getProfile, saveProfile } from '../db/profileRepository.js';

/** `GET /profile` / `POST /profile` — reads and saves the single stored profile. */
export const profileRoute = new Hono();

profileRoute.get('/profile', async (c) => {
  const profile = await getProfile();
  return c.json(profile);
});

profileRoute.post('/profile', async (c) => {
  const body = await c.req.json();
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const saved = await saveProfile(parsed.data);
  return c.json(saved);
});
