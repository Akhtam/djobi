import {
  TailoredResumeSchema,
  type JobInfo,
  type Profile,
  type TailoredResume,
} from '@djobi/shared';
import { MODELS } from './client.js';
import { callStructured } from './structuredCall.js';

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
