import {
  AddApplicationNoteRequestSchema,
  ApplicationSnapshotSchema,
  NewApplicationSchema,
  UpdateApplicationStageRequestSchema,
} from '@djobi/shared';
import { Hono, type Context } from 'hono';
import type { AuthEnv } from '../authMiddleware.js';
import type { ApplicationStore, Written } from '../db/applicationStore.js';
import { parseBody } from '../requestBody.js';

/**
 * Everything addressed at `/applications`: reading saved snapshots, creating one after an explicit
 * save, updating it on re-save, and the two interview-tracking writes (`PATCH …/:id/stage` and
 * `POST …/:id/notes`) that the dashboard uses.
 *
 * Tracking gets its own paths rather than riding on `PATCH /applications/:id`. That route's body is
 * an `ApplicationSnapshot`, which excludes stage and notes precisely so re-saving an autofill can't
 * overwrite them — folding them back in would undo the separation.
 *
 * `store` is a parameter for the same reason `client` is a prop in the extension's pages: these
 * routes are exercised end to end against an in-memory adapter, and `index.ts` is the only place the
 * Postgres one is named. See `db/applicationStore.ts`.
 *
 * `userId` comes from context on every handler below, set by `app.ts`'s `requireAuth` middleware
 * (real in production, a test double in `testApp.ts`) before any of these run — Phase B's
 * `docs/multi-tenant-auth.md` replaced the `BOOTSTRAP_USER_ID` constant this file used to read
 * directly with that.
 */
export function applicationsRoute(store: ApplicationStore): Hono<AuthEnv> {
  const route = new Hono<AuthEnv>();

  /**
   * Answers a write: the compact acknowledgement the store produced, or the full row the write left
   * behind, or a 404 when there was nothing to write to.
   *
   * The four writes below each spelled this out — the `if (!result) 404`, the `response=compact`
   * check, and the read-back — which is one protocol restated four times and got the last part wrong
   * in all four. The read-back used to `throw` when the row was gone, and `app.onError` turns a
   * throw into a 500: a row deleted between a write and its read-back was reported as "the backend
   * is broken", down the same channel as the model failing and Postgres being unreachable. It is the
   * same condition the line above it already answers with a 404, arriving a few milliseconds later.
   *
   * The read-back is now the exception rather than the rule. The row comes back from the write's own
   * `RETURNING` (see `Written`), so the default full-row response costs one Neon round trip instead
   * of two — and the deleted-between-write-and-read race that the paragraph above is about cannot
   * arise at all, because there is no window between the two.
   *
   * `store.byId` stays as the fallback for the one case the write cannot answer: a stored row that
   * no longer parses as an `Application`. Reaching for it there is deliberate — it throws a Zod
   * error naming the offending field, which is the report that condition deserves and exactly what
   * this route did before. A compact caller never reaches it, because it never wanted the row.
   *
   * `result` is what the store returned — `null` when no row has that id.
   */
  async function writeResponse<Result extends { id: string }>(
    c: Context<AuthEnv>,
    result: Written<Result> | null,
  ): Promise<Response> {
    if (!result) return c.json({ error: 'Application not found' }, 404);

    const { application, ...compact } = result;
    // Stripped rather than passed through: `application` is this seam's business, not the wire's,
    // and a compact response is compact because a caller said it wanted nothing more than the
    // acknowledgement.
    if (c.req.query('response') === 'compact') return c.json(compact);

    if (application) return c.json(application);

    const readBack = await store.byId(c.get('userId'), result.id);
    if (!readBack) return c.json({ error: 'Application not found' }, 404);
    return c.json(readBack);
  }

  /**
   * `?jobUrl=` keeps the legacy full-row lookup. Current clients add `response=compact` to get the
   * Duplicate Guard's summary without loading snapshots. This remains a query rather than its own
   * path because `/applications/…` is already claimed by the `:id` route below.
   */
  route.get('/applications', async (c) => {
    const jobUrl = c.req.query('jobUrl');
    if (jobUrl) {
      return c.json(
        c.req.query('response') === 'compact'
          ? await store.duplicateSummary(c.get('userId'), jobUrl)
          : await store.byJobUrl(c.get('userId'), jobUrl),
      );
    }
    return c.json(await store.list(c.get('userId')));
  });

  route.get('/applications/:id', async (c) => {
    const application = await store.byId(c.get('userId'), c.req.param('id'));
    if (!application) {
      return c.json({ error: 'Application not found' }, 404);
    }
    return c.json(application);
  });

  route.post('/applications', async (c) =>
    writeResponse(c, await store.create(c.get('userId'), await parseBody(c, NewApplicationSchema))),
  );

  route.patch('/applications/:id', async (c) =>
    writeResponse(
      c,
      await store.replaceSnapshot(
        c.get('userId'),
        c.req.param('id'),
        await parseBody(c, ApplicationSnapshotSchema),
      ),
    ),
  );

  /**
   * Registered before `PATCH /applications/:id`? No — order doesn't matter between these two,
   * because `/applications/:id/stage` has a path segment the `:id` pattern can't match. It is
   * written after the plain `:id` routes only to keep the file's read order (reads, create, update,
   * then tracking).
   */
  route.patch('/applications/:id/stage', async (c) => {
    const { stage } = await parseBody(c, UpdateApplicationStageRequestSchema);
    return writeResponse(c, await store.setStage(c.get('userId'), c.req.param('id'), stage));
  });

  route.post('/applications/:id/notes', async (c) =>
    writeResponse(
      c,
      await store.appendNote(
        c.get('userId'),
        c.req.param('id'),
        await parseBody(c, AddApplicationNoteRequestSchema),
      ),
    ),
  );

  /**
   * The only note operation that isn't an append. `:noteId` is a path parameter rather than a body,
   * because deleting one note is addressing it — and it keeps the route shaped like the resource
   * the append created.
   */
  route.delete('/applications/:id/notes/:noteId', async (c) =>
    writeResponse(
      c,
      await store.deleteNote(c.get('userId'), c.req.param('id'), c.req.param('noteId')),
    ),
  );

  return route;
}
