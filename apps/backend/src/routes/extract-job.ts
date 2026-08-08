import { Hono } from 'hono';
import { extractJob } from '../llm/extractJob.js';

/** `POST /extract-job` — extracts structured job info from scraped page text. */
export const extractJobRoute = new Hono();

extractJobRoute.post('/extract-job', async (c) => {
  const body = await c.req.json<{ pageText?: string }>();

  if (!body.pageText) {
    return c.json({ error: 'pageText is required' }, 400);
  }

  const jobInfo = await extractJob(body.pageText);
  return c.json(jobInfo);
});
