import { ExtractedProfileSchema, type ExtractedProfile } from '@djobi/shared';
import { extractPdfText } from '../pdf/extractPdfText.js';
import { sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/**
 * The PDF has no extractable text (scanned, corrupt, or not really a PDF). The route answers 400
 * so the candidate can act on it.
 */
export class NoResumeTextError extends Error {
  constructor() {
    super('No extractable text was found in this PDF.');
    this.name = 'NoResumeTextError';
  }
}

/**
 * Extracts a draft {@link ExtractedProfile} from an uploaded resume PDF. The text is untrusted, so
 * it goes through `sanitizeXmlContent` before reaching the model. Multi-column and table layouts
 * may extract imperfectly; the candidate reviews the draft before saving.
 *
 * @throws {NoResumeTextError} If the PDF has no extractable text.
 * @throws If the model returns no valid object.
 */
export async function extractResume(
  pdfBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractedProfile> {
  let text: string;
  try {
    text = await extractPdfText(pdfBytes);
  } catch {
    // Not really a PDF: same remedy as an image-only one, so the same error.
    throw new NoResumeTextError();
  }

  if (!text.trim()) {
    throw new NoResumeTextError();
  }

  return callStructured({
    signal,
    operation: 'extractResume',
    toolName: 'report_extracted_profile',
    toolDescription: 'Report the structured profile information extracted from the resume text.',
    schema: ExtractedProfileSchema,
    userContent: `Extract structured profile information from the following resume text. Only use information explicitly present in the text — leave a field null, or an empty array for a section, rather than guessing or inventing content the resume doesn't state. Preserve the candidate's own wording for the summary and every bullet point; this is a transcription into structure, not a rewrite.

Populate links.linkedin/links.portfolio/links.github from URLs found in the text, using whichever domain each one is; leave any not present as null. Populate workExperience, education, skills, projects, certifications and awards from their respective sections of the resume, in the order the resume itself lists them — an empty array for any section the resume doesn't have, never omitted.

<resume_text>
${sanitizeXmlContent(text)}
</resume_text>`,
  });
}
