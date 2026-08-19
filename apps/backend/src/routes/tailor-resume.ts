import { TailorResumeRequestSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import {
  listPriorApplicationsByCompany,
  type PriorApplication,
} from '../db/applicationsRepository.js';
import { tailorResume } from '../llm/tailorResume.js';

/**
 * Builds a short summary of past applications to the same company, one line per application, so
 * `tailorResume` can vary its phrasing instead of repeating a previous resume verbatim. `undefined`
 * when there's no history with this company yet.
 */
function buildPriorApplicationsSummary(pastApplications: PriorApplication[]): string | undefined {
  if (pastApplications.length === 0) return undefined;
  return pastApplications
    .map((application) => `${application.roleTitle} (${application.createdAt.slice(0, 10)})`)
    .join('\n');
}

/** `POST /tailor-resume` — tailors a resume's content to a specific job. */
export const tailorResumeRoute = new Hono();

tailorResumeRoute.post('/tailor-resume', async (c) => {
  const parsed = await parseBody(c, TailorResumeRequestSchema);

  const { profile, jobInfo } = parsed;
  const pastApplications = await listPriorApplicationsByCompany(jobInfo.company);
  const priorApplicationsSummary = buildPriorApplicationsSummary(pastApplications);
  const tailoredResume = await tailorResume(profile, jobInfo, priorApplicationsSummary);
  return c.json(tailoredResume);
});
