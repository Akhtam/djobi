import { JobInfoSchema, type JobInfo } from '@djobi/shared';
import { MODELS } from './client.js';
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
    model: MODELS.extractJob,
    maxTokens: 2048,
    toolName: 'report_job_info',
    toolDescription:
      'Report the structured job posting information extracted from the description.',
    schema: JobInfoSchema,
    userContent: `Extract structured job posting information from the following job description. Only use information present in the text — leave a field null rather than guessing.\n\n<job_description>\n${sanitizeXmlContent(jobDescription)}\n</job_description>`,
  });
}
