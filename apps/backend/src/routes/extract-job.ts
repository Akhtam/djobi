import { Hono } from 'hono';
import { extractJob } from '../llm/extractJob.js';

/** `POST /extract-job` — extracts structured job info from a pasted job description. */
export const extractJobRoute = new Hono();

extractJobRoute.post('/extract-job', async (c) => {
  const body = await c.req.json<{ jobDescription?: string }>();

  if (!body.jobDescription) {
    return c.json({ error: 'jobDescription is required' }, 400);
  }

  const jobInfo = await extractJob(body.jobDescription);
  return c.json(jobInfo);
});
