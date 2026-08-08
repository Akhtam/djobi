import { JobInfoSchema, type JobInfo } from '@djobi/shared';
import { MODELS } from './client.js';
import { callStructured } from './structuredCall.js';

/**
 * JSON Schema mirror of {@link JobInfoSchema}, hand-maintained since there's no automatic
 * zod-to-JSON-Schema conversion wired up (see `structuredCall.ts`).
 */
const jobInfoInputSchema = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    team: { type: ['string', 'null'], description: 'Team or department, if mentioned' },
    roleTitle: { type: 'string' },
    seniority: { type: ['string', 'null'], description: 'e.g. Junior, Senior, Staff' },
    location: { type: ['string', 'null'] },
    requirements: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete required/preferred qualifications extracted from the posting',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Skills/technologies/domain terms worth echoing in a tailored resume',
    },
  },
  required: ['company', 'team', 'roleTitle', 'seniority', 'location', 'requirements', 'keywords'],
} as const;

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
    inputSchema: jobInfoInputSchema,
    schema: JobInfoSchema,
    userContent: `Extract structured job posting information from the following scraped page text. Only use information present in the text — leave a field null rather than guessing.\n\n<page_text>\n${pageText}\n</page_text>`,
  });
}
