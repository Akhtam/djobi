import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Extracts a PDF's text using `unpdf`, with options shared by every caller in this codebase:
 * embedded ToUnicode maps rather than substitute display fonts, since these are headless
 * integrity/parsing reads, not renders. Kept in one place so the two current callers —
 * `preflightResume.ts`'s own-generated-PDF integrity check and `llm/extractResume.ts`'s
 * arbitrary uploaded-resume parse — can't drift apart on these options without both changing.
 */
export async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes), {
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  return (await extractText(pdf, { mergePages: true })).text;
}
