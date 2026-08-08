import { JobInfoSchema, ProfileSchema, type Application } from '@djobi/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { listApplicationsByCompany } from '../db/applicationsRepository.js';
import { tailorResume } from '../llm/tailorResume.js';

const TailorResumeBodySchema = z.object({
  profile: ProfileSchema,
  jobInfo: JobInfoSchema,
});

/**
 * Builds a short summary of past applications to the same company, one line per application, so
 * `tailorResume` can vary its phrasing instead of repeating a previous resume verbatim. `undefined`
 * when there's no history with this company yet.
 */
function buildPriorApplicationsSummary(pastApplications: Application[]): string | undefined {
  if (pastApplications.length === 0) return undefined;
  return pastApplications
    .map(
      (application) =>
        `${application.roleTitle} (${application.createdAt.slice(0, 10)}): ${application.tailoredResume.summary}`,
    )
    .join('\n');
}

/** `POST /tailor-resume` — tailors a resume's content to a specific job. */
export const tailorResumeRoute = new Hono();

tailorResumeRoute.post('/tailor-resume', async (c) => {
  const body = await c.req.json();
  const parsed = TailorResumeBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const { profile, jobInfo } = parsed.data;
  const pastApplications = await listApplicationsByCompany(jobInfo.company);
  const priorApplicationsSummary = buildPriorApplicationsSummary(pastApplications);
  const tailoredResume = await tailorResume(profile, jobInfo, priorApplicationsSummary);
  return c.json(tailoredResume);
});
