import { ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import { getProfile, saveProfile } from '../db/profileRepository.js';

/** `GET /profile` / `POST /profile` — reads and saves the single stored profile. */
export const profileRoute = new Hono();

profileRoute.get('/profile', async (c) => {
  const profile = await getProfile();
  return c.json(profile);
});

profileRoute.post('/profile', async (c) => {
  const parsed = await parseBody(c, ProfileSchema);

  const saved = await saveProfile(parsed);
  return c.json(saved);
});
