import { JobInfoSchema, type JobInfo } from '@djobi/shared';
import { MODELS } from './client.js';
import { callStructured } from './structuredCall.js';

/**
 * Extracts structured job posting information (company, role, requirements, keywords, ...) from
 * a job page's scraped text, using the cheap extraction model (`MODELS.extraction`).
 *
 * @param pageText - Scraped/cleaned text content of the job posting page.
 * @returns The extracted, validated {@link JobInfo}.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function extractJob(pageText: string): Promise<JobInfo> {
  return callStructured({
    model: MODELS.extraction,
    maxTokens: 2048,
    toolName: 'report_job_info',
    toolDescription: 'Report the structured job posting information extracted from the page text.',
    schema: JobInfoSchema,
    userContent: `Extract structured job posting information from the following scraped page text. Only use information present in the text — leave a field null rather than guessing.\n\n<page_text>\n${pageText}\n</page_text>`,
  });
}
