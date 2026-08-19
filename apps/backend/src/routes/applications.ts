import {
  AddApplicationNoteRequestSchema,
  ApplicationSnapshotSchema,
  NewApplicationSchema,
  UpdateApplicationStageRequestSchema,
} from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import {
  addApplicationNote,
  getApplicationDuplicateSummary,
  getApplicationById,
  listApplications,
  listApplicationsByJobUrl,
  saveApplication,
  updateApplication,
  updateApplicationStage,
} from '../db/applicationsRepository.js';

/**
 * Everything addressed at `/applications`: reading saved snapshots, creating one after an explicit
 * save, updating it on re-save, and the two interview-tracking writes (`PATCH …/:id/stage` and
 * `POST …/:id/notes`) that the dashboard uses.
 *
 * Tracking gets its own paths rather than riding on `PATCH /applications/:id`. That route's body is
 * an `ApplicationSnapshot`, which excludes stage and notes precisely so re-saving an autofill can't
 * overwrite them — folding them back in would undo the separation.
 */
export const applicationsRoute = new Hono();

async function requireApplication(id: string) {
  const application = await getApplicationById(id);
  if (!application) throw new Error(`Application ${id} disappeared after a successful write`);
  return application;
}

/**
 * `?jobUrl=` keeps the legacy full-row lookup. Current clients add `response=compact` to get the
 * Duplicate Guard's summary without loading snapshots. This remains a query rather than its own
 * path because `/applications/…` is already claimed by the `:id` route below.
 */
applicationsRoute.get('/applications', async (c) => {
  const jobUrl = c.req.query('jobUrl');
  if (jobUrl) {
    return c.json(
      c.req.query('response') === 'compact'
        ? await getApplicationDuplicateSummary(jobUrl)
        : await listApplicationsByJobUrl(jobUrl),
    );
  }
  return c.json(await listApplications());
});

applicationsRoute.get('/applications/:id', async (c) => {
  const application = await getApplicationById(c.req.param('id'));
  if (!application) {
    return c.json({ error: 'Application not found' }, 404);
  }
  return c.json(application);
});

applicationsRoute.post('/applications', async (c) => {
  const parsed = await parseBody(c, NewApplicationSchema);

  const saved = await saveApplication(parsed);
  return c.json(c.req.query('response') === 'compact' ? saved : await requireApplication(saved.id));
});

applicationsRoute.patch('/applications/:id', async (c) => {
  const parsed = await parseBody(c, ApplicationSnapshotSchema);

  const updated = await updateApplication(c.req.param('id'), parsed);
  if (!updated) {
    return c.json({ error: 'Application not found' }, 404);
  }
  return c.json(
    c.req.query('response') === 'compact' ? updated : await requireApplication(updated.id),
  );
});

/**
 * Registered before `PATCH /applications/:id`? No — order doesn't matter between these two, because
 * `/applications/:id/stage` has a path segment the `:id` pattern can't match. It is written after
 * the plain `:id` routes only to keep the file's read order (reads, create, update, then tracking).
 */
applicationsRoute.patch('/applications/:id/stage', async (c) => {
  const parsed = await parseBody(c, UpdateApplicationStageRequestSchema);

  const updated = await updateApplicationStage(c.req.param('id'), parsed.stage);
  if (!updated) {
    return c.json({ error: 'Application not found' }, 404);
  }
  return c.json(
    c.req.query('response') === 'compact' ? updated : await requireApplication(updated.id),
  );
});

applicationsRoute.post('/applications/:id/notes', async (c) => {
  const parsed = await parseBody(c, AddApplicationNoteRequestSchema);

  const updated = await addApplicationNote(c.req.param('id'), parsed);
  if (!updated) {
    return c.json({ error: 'Application not found' }, 404);
  }
  return c.json(
    c.req.query('response') === 'compact' ? updated : await requireApplication(updated.id),
  );
});
