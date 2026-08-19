import { TailorResumeRequestSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import { tailorResume } from '../llm/tailorResume.js';

/** `POST /tailor-resume` — tailors a resume's content to a specific job. */
export const tailorResumeRoute = new Hono();

tailorResumeRoute.post('/tailor-resume', async (c) => {
  const parsed = await parseBody(c, TailorResumeRequestSchema);

  const { profile, jobInfo } = parsed;
  const tailoredResume = await tailorResume(profile, jobInfo);
  return c.json(tailoredResume);
});
