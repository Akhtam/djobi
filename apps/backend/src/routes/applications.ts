import {
  AddApplicationNoteRequestSchema,
  ApplicationSnapshotSchema,
  NewApplicationSchema,
  UpdateApplicationStageRequestSchema,
} from '@djobi/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../authMiddleware.js';
import type { ApplicationStore, Written } from '../db/applicationStore.js';
import { jsonBody, pathParams, queryParams } from '../requestBody.js';

/** `GET /applications` query. An empty `?jobUrl=` means "list everything", same as absent. */
const ListApplicationsQuerySchema = z.object({ jobUrl: z.string().optional() });

/** `:id` on every route below; can't actually reject a routed request (see {@link pathParams}). */
const ApplicationIdParamSchema = z.object({ id: z.string().min(1) });

/** `:id`/`:noteId` together, for the one route addressing both. */
const ApplicationNoteIdParamSchema = z.object({
  id: z.string().min(1),
  noteId: z.string().min(1),
});

/**
 * `/applications`: read, create (explicit save), re-save the snapshot, and the dashboard's tracking
 * writes. Stage and notes have their own paths because `PATCH /applications/:id` takes an
 * `ApplicationSnapshot`, which excludes them so a re-save can't overwrite tracking.
 *
 * `store` is injected so routes run against the in-memory adapter in tests; `userId` comes from
 * `requireAuth` in context.
 */
export function applicationsRoute(store: ApplicationStore): Hono<AuthEnv> {
  const route = new Hono<AuthEnv>();

  /**
   * Answers a write: 404 when `result` is `null`, the compact acknowledgement for
   * `response=compact`, else the full row from the write's own `RETURNING`. Falls back to
   * `store.byId` only when that row doesn't parse, so the Zod error names the bad field.
   */
  async function writeResponse<Result extends { id: string }>(
    c: Context<AuthEnv>,
    result: Written<Result> | null,
  ): Promise<Response> {
    if (!result) return c.json({ error: 'Application not found' }, 404);

    const { application, ...compact } = result;
    // `application` is internal to this seam; compact callers get only the acknowledgement.
    if (c.req.query('response') === 'compact') return c.json(compact);

    if (application) return c.json(application);

    const readBack = await store.byId(c.get('userId'), result.id);
    if (!readBack) return c.json({ error: 'Application not found' }, 404);
    return c.json(readBack);
  }

  /**
   * `?jobUrl=` returns full matching rows; with `response=compact` it returns the Duplicate Guard's
   * summary instead. A query, since `/applications/…` is taken by `:id`.
   */
  route.get('/applications', queryParams(ListApplicationsQuerySchema), async (c) => {
    const { jobUrl } = c.req.valid('query');
    if (jobUrl) {
      return c.json(
        c.req.query('response') === 'compact'
          ? await store.duplicateSummary(c.get('userId'), jobUrl)
          : await store.byJobUrl(c.get('userId'), jobUrl),
      );
    }
    return c.json(await store.list(c.get('userId')));
  });

  route.get('/applications/:id', pathParams(ApplicationIdParamSchema), async (c) => {
    const application = await store.byId(c.get('userId'), c.req.valid('param').id);
    if (!application) {
      return c.json({ error: 'Application not found' }, 404);
    }
    return c.json(application);
  });

  /** An optional `idempotency-key` header makes retries safe (see `ApplicationStore.create`). */
  route.post('/applications', jsonBody(NewApplicationSchema), async (c) =>
    writeResponse(
      c,
      await store.create(c.get('userId'), c.req.valid('json'), c.req.header('idempotency-key')),
    ),
  );

  route.patch(
    '/applications/:id',
    pathParams(ApplicationIdParamSchema),
    jsonBody(ApplicationSnapshotSchema),
    async (c) =>
      writeResponse(
        c,
        await store.replaceSnapshot(c.get('userId'), c.req.valid('param').id, c.req.valid('json')),
      ),
  );

  /** Stage changes (dashboard). */
  route.patch(
    '/applications/:id/stage',
    pathParams(ApplicationIdParamSchema),
    jsonBody(UpdateApplicationStageRequestSchema),
    async (c) => {
      const { stage } = c.req.valid('json');
      return writeResponse(
        c,
        await store.setStage(c.get('userId'), c.req.valid('param').id, stage),
      );
    },
  );

  route.post(
    '/applications/:id/notes',
    pathParams(ApplicationIdParamSchema),
    jsonBody(AddApplicationNoteRequestSchema),
    async (c) =>
      writeResponse(
        c,
        await store.appendNote(c.get('userId'), c.req.valid('param').id, c.req.valid('json')),
      ),
  );

  /** Deletes one note, addressed by path. */
  route.delete(
    '/applications/:id/notes/:noteId',
    pathParams(ApplicationNoteIdParamSchema),
    async (c) => {
      const { id, noteId } = c.req.valid('param');
      return writeResponse(c, await store.deleteNote(c.get('userId'), id, noteId));
    },
  );

  /** Deletes the Application: `{ id }`, or 404 if this user has no such row. */
  route.delete('/applications/:id', pathParams(ApplicationIdParamSchema), async (c) => {
    const result = await store.deleteApplication(c.get('userId'), c.req.valid('param').id);
    if (!result) return c.json({ error: 'Application not found' }, 404);
    return c.json(result);
  });

  return route;
}
