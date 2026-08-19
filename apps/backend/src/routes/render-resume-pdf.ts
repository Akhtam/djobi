import { RenderResumePdfRequestSchema, resumeFileName } from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import { renderResumePdf } from '../pdf/renderResume.js';

/** `POST /render-resume-pdf` — renders a tailored resume to PDF bytes. */
export const renderResumePdfRoute = new Hono();

let cachedRender: { key: string; promise: Promise<Buffer> } | undefined;

renderResumePdfRoute.post('/render-resume-pdf', async (c) => {
  const parsed = await parseBody(c, RenderResumePdfRequestSchema);

  const { profile, tailoredResume } = parsed;
  const key = JSON.stringify([profile, tailoredResume]);

  if (cachedRender?.key !== key) {
    const promise = renderResumePdf(profile, tailoredResume);
    cachedRender = { key, promise };
    void promise.catch(() => {
      if (cachedRender?.promise === promise) cachedRender = undefined;
    });
  }

  const pdfBuffer = await cachedRender.promise;
  return new Response(pdfBuffer, {
    headers: {
      'content-type': 'application/pdf',
      // Named after the profile so a saved/previewed copy matches the file the extension attaches.
      'content-disposition': `inline; filename="${resumeFileName(profile.fullName)}"`,
    },
  });
});
