/**
 * Regenerates `src/pdf/notoSansFonts.ts` from the `@expo-google-fonts/noto-sans` package.
 *
 * The renderer needs the font *bytes*, and it has to get them the same way in every environment it
 * runs in: Node (`pnpm dev`, `pnpm build`), vitest, and — the reason this file exists — a
 * Cloudflare Worker. Reading them off disk (`createRequire(...).resolve` + `fs`) is what the
 * previous `@react-pdf/renderer` implementation did, and it is precisely what a Worker cannot do:
 * there is no filesystem, and the module-scope `createRequire(import.meta.url)` call it needed
 * fails to evaluate at all, taking the whole Worker down on cold start rather than just this route.
 *
 * Base64 in a committed module is therefore deliberate. It is bytes the bundler carries, so it
 * works unchanged everywhere and needs no per-platform branch, no build-order hook, and no
 * generated file that CI has to remember to create before `tsc` runs.
 *
 * Run with: pnpm --filter backend fonts:generate
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import subsetFont from 'subset-font';

const require = createRequire(import.meta.url);

/**
 * The scripts a rendered resume is allowed to contain, as Unicode ranges.
 *
 * Shipping the full faces costs ~1.26 MB of font for a document that uses a few hundred glyphs, and
 * a Worker pays for that in its bundle on every deploy. Subsetting to these ranges cuts it to
 * ~0.4 MB while covering every script the product can actually render today.
 *
 * **This set defines a real product limit, not just a size trade.** A glyph outside it does not
 * reach the page as written: the subsetter drops it, and what lands in the content stream is
 * whatever the shaper falls back to — often a *different* glyph rather than a visible `.notdef`
 * box, so the failure is silent at the pixel level and only `preflightResumePdf` catches it, when
 * the extracted text stops matching the candidate's own words. That behaviour predates subsetting
 * — the full Noto Sans has no CJK either, so a CJK name already failed — but this list is now the
 * place that decides it. Adding a script means adding its range here *and* checking the size cost,
 * not just shipping more font.
 *
 * Combining marks (U+0300–U+036F) are here for a reason that is easy to miss: text does not arrive
 * normalised. `extractPdfText` (pdf.js) routinely yields *decomposed* (NFD) sequences from uploaded
 * resumes and the LLM copies a name straight through, so `José` can reach the renderer as `e` +
 * U+0301. Without the marks that is a hard 500 on `POST /render-resume-pdf` for anyone with an
 * accented name.
 */
const UNICODE_RANGES = [
  [0x0000, 0x00ff], // Basic Latin + Latin-1 Supplement (includes `·`, the contact-line separator)
  [0x0300, 0x036f], // Combining Diacritical Marks (decomposed/NFD accents — see above)
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
  [0x1e00, 0x1eff], // Latin Extended Additional (Vietnamese)
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x0500, 0x052f], // Cyrillic Supplement
  [0x2000, 0x206f], // General Punctuation (`–`, `—`, `•`, curly quotes)
  [0x20a0, 0x20cf], // Currency symbols
  [0x2100, 0x214f], // Letterlike symbols (`™`, `№`)
  [0x2212, 0x2212], // Minus sign
] as const;

/** Every code point in {@link UNICODE_RANGES}, as the string `subset-font` wants. */
const subsetText = UNICODE_RANGES.flatMap(([start, end]) =>
  Array.from({ length: end - start + 1 }, (_, i) => String.fromCodePoint(start + i)),
).join('');

const FONTS = {
  notoSansRegularBase64: '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
  notoSansBoldBase64: '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf',
} as const;

const chunks: string[] = [];
for (const [name, specifier] of Object.entries(FONTS)) {
  const full = await readFile(require.resolve(specifier));
  const subset = await subsetFont(full, subsetText, { targetFormat: 'truetype' });
  const saved = (100 * (1 - subset.length / full.length)).toFixed(0);
  console.log(`${name}: ${full.length} -> ${subset.length} bytes (${saved}% smaller)`);
  chunks.push(`export const ${name} =\n  '${subset.toString('base64')}';`);
}

const header = `/**
 * Noto Sans 400/700 as base64, generated from \`@expo-google-fonts/noto-sans\` — do not edit by hand.
 *
 * Regenerate with \`pnpm --filter backend fonts:generate\` (\`scripts/generateFonts.mts\`, which
 * explains why the bytes are inlined rather than read from disk: a Cloudflare Worker has no
 * filesystem, and the \`createRequire\` call that read them before failed at module scope there,
 * taking down the entire Worker rather than only the PDF route).
 *
 * These are **subsetted** to the scripts that script lists — Latin, Greek and Cyrillic, plus the
 * combining marks, punctuation and currency the layout uses. That is a product limit as much as a
 * size one: a glyph outside the set is dropped, the shaper substitutes something else for it, and
 * \`preflightResumePdf\` fails the render. See the generator for the ranges and for what adding a
 * script costs.
 *
 * \`pdf/renderResume.ts\` decodes these once at module scope and hands the bytes to
 * \`pdf.embedFont(...)\`. Only the glyphs a given resume actually uses are written into the output
 * PDF — \`save({ subsetFonts: true })\` subsets them again per render — so neither these files nor
 * their full originals ever reach a candidate.
 */
`;

await writeFile(
  new URL('../src/pdf/notoSansFonts.ts', import.meta.url),
  `${header}\n${chunks.join('\n\n')}\n`,
);
console.log('wrote src/pdf/notoSansFonts.ts');
