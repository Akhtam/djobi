import { ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthEnv } from '../authMiddleware.js';
import type { ProfileStore } from '../db/profileStore.js';
import { extractResume, NoResumeTextError } from '../llm/extractResume.js';
import { jsonBody, RequestValidationError } from '../requestBody.js';

/**
 * Upload cap. Hono's multipart parser has no limit, so `bodyLimit` enforces it — including by
 * counting the stream when `content-length` is missing or understated.
 */
const MAX_RESUME_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * `GET`/`POST /profile` read and save the current user's Profile; `POST /profile/extract-resume`
 * parses an uploaded resume PDF into a draft for review. `store` is injected; `userId` comes from
 * `requireAuth`.
 */
export function profileRoute(store: ProfileStore): Hono<AuthEnv> {
  const route = new Hono<AuthEnv>();

  route.get('/profile', async (c) => {
    const profile = await store.get(c.get('userId'));
    return c.json(profile);
  });

  route.post('/profile', jsonBody(ProfileSchema), async (c) => {
    const saved = await store.save(c.get('userId'), c.req.valid('json'));
    return c.json(saved);
  });

  /** Never saves: the candidate reviews the draft, and `POST /profile` is the only save path. */
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
        // No extractable text: rejected like any other unusable upload, so the candidate can fall
        // back to manual entry.
        if (error instanceof NoResumeTextError) {
          throw new RequestValidationError(error.message);
        }
        throw error;
      }
    },
  );

  return route;
}
