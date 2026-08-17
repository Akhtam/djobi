import { ApplicationSnapshotSchema, NewApplicationSchema } from '@djobi/shared';
import { Hono } from 'hono';
import {
  getApplicationById,
  listApplications,
  listApplicationsByJobUrl,
  saveApplication,
  updateApplication,
} from '../db/applicationsRepository.js';

/**
 * `GET /applications` / `GET /applications/:id` / `POST /applications` / `PATCH /applications/:id`
 * reads saved application snapshots, creates one after an explicit save, and updates it on re-save.
 */
export const applicationsRoute = new Hono();

/**
 * `?jobUrl=` narrows the list to one posting rather than living at its own path: `/applications/…`
 * is already claimed by the `:id` route below, so a sibling `/applications/lookup` would depend on
 * registration order to not be read as an id.
 */
applicationsRoute.get('/applications', async (c) => {
  const jobUrl = c.req.query('jobUrl');
  const applications = jobUrl ? await listApplicationsByJobUrl(jobUrl) : await listApplications();
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

applicationsRoute.patch('/applications/:id', async (c) => {
  const body = await c.req.json();
  const parsed = ApplicationSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const updated = await updateApplication(c.req.param('id'), parsed.data);
  if (!updated) {
    return c.json({ error: 'Application not found' }, 404);
  }
  return c.json(updated);
});
