import { NewApplicationSchema } from '@djobi/shared';
import { Hono } from 'hono';
import {
  getApplicationById,
  listApplications,
  saveApplication,
} from '../db/applicationsRepository.js';

/**
 * `GET /applications` / `GET /applications/:id` / `POST /applications` — reads past autofilled
 * applications and writes a new one once a fill completes.
 */
export const applicationsRoute = new Hono();

applicationsRoute.get('/applications', async (c) => {
  const applications = await listApplications();
  return c.json(applications);
});

applicationsRoute.get('/applications/:id', async (c) => {
  const application = await getApplicationById(c.req.param('id'));
  if (!application) {
    return c.json({ error: 'Application not found' }, 404);
  }
  return c.json(application);
});

applicationsRoute.post('/applications', async (c) => {
  const body = await c.req.json();
  const parsed = NewApplicationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const saved = await saveApplication(parsed.data);
  return c.json(saved);
});
