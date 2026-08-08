import { JobInfoSchema, ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { tailorResume } from '../llm/tailorResume.js';

const TailorResumeBodySchema = z.object({
  profile: ProfileSchema,
  jobInfo: JobInfoSchema,
  priorApplicationsSummary: z.string().optional(),
});

/** `POST /tailor-resume` — tailors a resume's content to a specific job. */
export const tailorResumeRoute = new Hono();

tailorResumeRoute.post('/tailor-resume', async (c) => {
  const body = await c.req.json();
  const parsed = TailorResumeBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const { profile, jobInfo, priorApplicationsSummary } = parsed.data;
  const tailoredResume = await tailorResume(profile, jobInfo, priorApplicationsSummary);
  return c.json(tailoredResume);
});
