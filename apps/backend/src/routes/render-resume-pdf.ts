import { RenderResumePdfRequestSchema, resumeFileName } from '@djobi/shared';
import { Hono } from 'hono';
import { jsonBody } from '../requestBody.js';
import { renderResumePdf } from '../pdf/renderResume.js';

/** `POST /render-resume-pdf` — renders a tailored resume to PDF bytes. */
export const renderResumePdfRoute = new Hono();

renderResumePdfRoute.post(
  '/render-resume-pdf',
  jsonBody(RenderResumePdfRequestSchema),
  async (c) => {
    const { profile, tailoredResume } = c.req.valid('json');
    const pdfBytes = await renderResumePdf(profile, tailoredResume);
    return new Response(pdfBytes, {
      headers: {
        'content-type': 'application/pdf',
        // Named after the profile so a saved/previewed copy matches the file the extension
        // attaches.
        'content-disposition': `inline; filename="${resumeFileName(profile.fullName)}"`,
      },
    });
  },
);
