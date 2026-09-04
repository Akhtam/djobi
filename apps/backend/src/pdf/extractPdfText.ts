import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Extracts a PDF's text using `unpdf`, with options shared by every caller in this codebase:
 * embedded ToUnicode maps rather than substitute display fonts, since these are headless
 * integrity/parsing reads, not renders. Kept in one place so the two current callers —
 * `preflightResume.ts`'s own-generated-PDF integrity check and `llm/extractResume.ts`'s
 * arbitrary uploaded-resume parse — can't drift apart on these options without both changing.
 */
export async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  // Copied, not passed through: pdf.js takes ownership of the buffer it is handed and *detaches*
  // it, so a caller that still needs its own bytes afterwards would otherwise find them gone. That
  // caller is `renderResumePdf`: it preflights the bytes it just rendered and then returns those
  // same bytes to the route, so without the copy the response body would go out empty.
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes), {
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  return (await extractText(pdf, { mergePages: true })).text;
}
