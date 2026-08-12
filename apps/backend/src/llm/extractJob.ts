import { JobInfoSchema, type JobInfo } from '@djobi/shared';
import { MODELS } from './client.js';
import { callStructured } from './structuredCall.js';

/**
 * Extracts structured job posting information (company, role, requirements, keywords, ...) from a
 * job description, using the cheap extraction model (`MODELS.extraction`).
 *
 * The text is the posting as the candidate pasted it, not a scrape of the page they were on. The
 * extension used to send the latter and the prompt said so, which was worth correcting rather than
 * leaving stale: told it is reading "scraped page text", the model expects and tolerates the
 * surrounding junk a scrape carries (nav bars, cookie banners, the application form's own labels)
 * and will happily pull a "requirement" out of it.
 *
 * @param jobDescription - The job posting text.
 * @returns The extracted, validated {@link JobInfo}.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function extractJob(jobDescription: string): Promise<JobInfo> {
  return callStructured({
    model: MODELS.extraction,
    maxTokens: 2048,
    toolName: 'report_job_info',
    toolDescription:
      'Report the structured job posting information extracted from the description.',
    schema: JobInfoSchema,
    userContent: `Extract structured job posting information from the following job description. Only use information present in the text — leave a field null rather than guessing.\n\n<job_description>\n${jobDescription}\n</job_description>`,
  });
}
