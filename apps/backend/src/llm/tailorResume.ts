import {
  TailoredResumeSchema,
  type JobInfo,
  type Profile,
  type TailoredResume,
} from '@djobi/shared';
import { MODELS } from './client.js';
import { callStructured } from './structuredCall.js';

/** JSON Schema for one `TailoredResume.workExperience` entry — mirrors {@link TailoredResumeSchema}. */
const workExperienceItemSchema = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    title: { type: 'string' },
    startDate: { type: 'string' },
    endDate: { type: ['string', 'null'] },
    bullets: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Reworded/reordered bullets emphasizing relevance to the job; must not invent facts not present in the base profile',
    },
  },
  required: ['company', 'title', 'startDate', 'endDate', 'bullets'],
} as const;

/** JSON Schema mirror of {@link TailoredResumeSchema}, hand-maintained (see `structuredCall.ts`). */
const tailoredResumeInputSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '2-3 sentence summary tailored to this job, grounded only in the base profile',
    },
    skills: {
      type: 'array',
      items: { type: 'string' },
      description: "Subset/reordering of the base profile's skills most relevant to this job",
    },
    workExperience: { type: 'array', items: workExperienceItemSchema },
  },
  required: ['summary', 'skills', 'workExperience'],
} as const;

/**
 * Tailors a resume's content to a specific job, using the writing model (`MODELS.writing`).
 * Reorders/rewords the profile's existing experience bullets to emphasize what's relevant to the
 * job's requirements/keywords; the prompt explicitly forbids inventing experience not present in
 * `profile`.
 *
 * @param profile - The candidate's base profile (source of truth — nothing is invented beyond it).
 * @param jobInfo - The job to tailor toward, as extracted by {@link extractJob}.
 * @param priorApplicationsSummary - Optional short summary of past applications to the same
 *   company (e.g. pulled from the `applications` table), so the model varies phrasing instead of
 *   repeating itself across applications to the same employer.
 * @returns The tailored, validated {@link TailoredResume}.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function tailorResume(
  profile: Profile,
  jobInfo: JobInfo,
  priorApplicationsSummary?: string,
): Promise<TailoredResume> {
  return callStructured({
    model: MODELS.writing,
    maxTokens: 4096,
    toolName: 'report_tailored_resume',
    toolDescription: 'Report the resume content tailored to this specific job.',
    inputSchema: tailoredResumeInputSchema,
    schema: TailoredResumeSchema,
    userContent: `You are tailoring a resume to a specific job posting. Reorder and reword the candidate's existing experience bullets to emphasize what's relevant to this job's requirements and keywords. Never invent experience, skills, or achievements that are not present in the base profile.

<base_profile>
${JSON.stringify(profile, null, 2)}
</base_profile>

<job_info>
${JSON.stringify(jobInfo, null, 2)}
</job_info>
${
  priorApplicationsSummary
    ? `\n<prior_applications_to_this_company>\n${priorApplicationsSummary}\n</prior_applications_to_this_company>\n\nVary phrasing from prior applications to this company rather than repeating them verbatim.`
    : ''
}`,
  });
}
