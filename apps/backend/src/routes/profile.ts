import { ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthEnv } from '../authMiddleware.js';
import type { ProfileStore } from '../db/profileStore.js';
import { extractResume, NoResumeTextError } from '../llm/extractResume.js';
import { parseBody, RequestValidationError } from '../requestBody.js';

/**
 * Hono's multipart parser has no built-in size limit — it buffers the whole body regardless. The
 * `bodyLimit` middleware below trusts an honestly reported `content-length` header, but for a
 * request that omits or understates it, reads the raw body stream in chunks and rejects as soon as
 * the running total crosses the limit — bounding memory before `parseBody()` ever runs, rather than
 * after the whole body has already been buffered.
 */
const MAX_RESUME_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * `GET /profile` / `POST /profile` — reads and saves the stored profile for the current user.
 * `POST /profile/extract-resume` — parses an uploaded resume PDF into a draft `Profile` extraction
 * for the candidate to review; see Phase 20 in `PROGRESS.md`.
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

  /**
   * Deliberately never calls `store.save` — extraction and saving stay two separate concerns, the
   * same separation the extension pipeline already keeps between its Fill and Save steps. The
   * candidate reviews and edits the draft this returns; `POST /profile` above is the only save path.
   */
  route.post(
    '/profile/extract-resume',
    bodyLimit({
      maxSize: MAX_RESUME_UPLOAD_BYTES,
      onError: () => {
        throw new RequestValidationError(
          `Resume upload exceeds the ${MAX_RESUME_UPLOAD_BYTES}-byte limit.`,
        );
      },
    }),
    async (c) => {
      let body: Awaited<ReturnType<typeof c.req.parseBody>>;
      try {
        body = await c.req.parseBody();
      } catch {
        throw new RequestValidationError('Could not parse the upload as multipart form data.');
      }

      const file = body.resume;
      if (!(file instanceof File)) {
        throw new RequestValidationError('Expected a "resume" file field in the upload.');
      }
      if (file.type !== 'application/pdf') {
        throw new RequestValidationError('Only PDF resumes are supported.');
      }
      if (file.size > MAX_RESUME_UPLOAD_BYTES) {
        throw new RequestValidationError(
          `Resume upload exceeds the ${MAX_RESUME_UPLOAD_BYTES}-byte limit.`,
        );
      }

      const pdfBytes = new Uint8Array(await file.arrayBuffer());

      try {
        const extracted = await extractResume(pdfBytes, c.req.raw.signal);
        return c.json(extracted);
      } catch (error) {
        // A PDF with no extractable text (scanned/image-based, corrupt, or not really a PDF) is the
        // candidate's file being what it is, not the request being malformed — but it's the same
        // "explain and let them fall back to manual entry" shape every other rejected upload here
        // gets, so it goes through the same convention.
        if (error instanceof NoResumeTextError) {
          throw new RequestValidationError(error.message);
        }
        throw error;
      }
    },
  );

  return route;
}
