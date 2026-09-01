import { JobInfoSchema, type JobInfo } from '@djobi/shared';
import { sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/**
 * Extracts structured job posting information (company, role, requirements, keywords, ...) from a
 * job description.
 *
 * The text is the candidate-reviewed Job Description field, not an unfiltered page dump. Autofill
 * can populate that field with a focused extractor, but the candidate can edit it before this call
 * and the prompt should not teach the model to tolerate navigation, form labels or cookie banners.
 *
 * @param jobDescription - The job posting text.
 * @returns The extracted, validated {@link JobInfo}.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function extractJob(jobDescription: string, signal?: AbortSignal): Promise<JobInfo> {
  return callStructured({
    signal,
    operation: 'extractJob',
    toolName: 'report_job_info',
    toolDescription:
      'Report the structured job posting information extracted from the description.',
    schema: JobInfoSchema,
    userContent: `Extract structured job posting information from the following job description. Only use information present in the text — leave a field null rather than guessing.

For keywords, name each term in its canonical, expanded, industry-standard form (e.g. "Kubernetes" not "K8s", "JavaScript" not "JS", "React" not "React.js"), one or two words each, roughly fifteen terms at most — the most important skills, technologies and domain terms the posting is worth echoing, not every noun it mentions. Also report postingSpelling: the exact wording the posting itself used for that term (e.g. "K8s"), or null if the posting already wrote it in the canonical form.

For requirements, set kind to "required" or "preferred" only when the posting draws that distinction plainly, under its own heading or wording (e.g. "Requirements" versus "Nice to have"). Use "unspecified" whenever it does not — never default to "required" for a posting that states no distinction. Extract yearsOfExperience only when the posting states a number for that specific requirement; leave it null rather than guessing, the same as any other field.

<job_description>
${sanitizeXmlContent(jobDescription)}
</job_description>`,
  });
}
