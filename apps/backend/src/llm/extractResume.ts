import { ExtractedProfileSchema, type ExtractedProfile } from '@djobi/shared';
import { extractPdfText } from '../pdf/extractPdfText.js';
import { sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/**
 * A PDF with no extractable text layer — scanned/image-based pages, or a corrupt file. Distinct
 * from a validation error: the upload itself was a well-formed request, the file just has nothing
 * this route can read. The route (20.3) maps this to a 400 the candidate can act on rather than the
 * generic 500 an unrelated PDF-parsing failure would otherwise become.
 */
export class NoResumeTextError extends Error {
  constructor() {
    super('No extractable text was found in this PDF.');
    this.name = 'NoResumeTextError';
  }
}

/**
 * Extracts a draft {@link ExtractedProfile} from an uploaded resume PDF's text.
 *
 * Text extraction uses the shared `extractPdfText` helper `pdf/preflightResume.ts` already uses.
 * Unlike that module's use of it, this is the first time this codebase asks it to cope with an
 * arbitrary, real-world resume's layout (columns, tables) rather than the app's own well-formed,
 * self-generated PDFs — see the phase plan in `PROGRESS.md` for why that's flagged as unproven, not
 * assumed solved.
 *
 * The extracted text is untrusted, attacker-authored input exactly like a pasted job description,
 * so it goes through `sanitizeXmlContent` before it reaches the model — the same prompt-injection
 * guard `extractJob.ts` already applies.
 *
 * @param pdfBytes - The uploaded file's raw bytes.
 * @returns The extracted, validated {@link ExtractedProfile} draft.
 * @throws {NoResumeTextError} If the PDF has no extractable text.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function extractResume(
  pdfBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractedProfile> {
  let text: string;
  try {
    text = await extractPdfText(pdfBytes);
  } catch {
    // A file that isn't really a PDF (a renamed extension, a spoofed content-type the route's own
    // check let through) fails here, not later — from the candidate's side this has the same remedy
    // as a scanned/image-only PDF, so it surfaces as the same error rather than an unrelated 500.
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
