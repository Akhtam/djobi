import { ProfileSchema, TailoredResumeSchema, resumeFileName } from '@djobi/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { renderResumePdf } from '../pdf/renderResume.js';

const RenderResumePdfBodySchema = z.object({
  profile: ProfileSchema,
  tailoredResume: TailoredResumeSchema,
});

/** `POST /render-resume-pdf` — renders a tailored resume to PDF bytes. */
export const renderResumePdfRoute = new Hono();

renderResumePdfRoute.post('/render-resume-pdf', async (c) => {
  const body = await c.req.json();
  const parsed = RenderResumePdfBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const { profile, tailoredResume } = parsed.data;
  const pdfBuffer = await renderResumePdf(profile, tailoredResume);
  return new Response(pdfBuffer, {
    headers: {
      'content-type': 'application/pdf',
      // Named after the profile so a saved/previewed copy matches the file the extension attaches.
      'content-disposition': `inline; filename="${resumeFileName(profile.fullName)}"`,
    },
  });
});
