import { extractText, getDocumentProxy } from 'unpdf';

/**
 * A PDF's text via `unpdf`, with options shared by both callers (`preflightResume.ts` and
 * `llm/extractResume.ts`): embedded ToUnicode maps, no substitute display fonts.
 */
export async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  // Copied: pdf.js detaches the buffer it's given, and `renderResumePdf` still needs its bytes
  // after preflighting them.
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes), {
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  return (await extractText(pdf, { mergePages: true })).text;
}
