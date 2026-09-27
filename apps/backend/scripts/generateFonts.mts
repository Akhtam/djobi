/**
 * Regenerates `src/pdf/notoSansFonts.ts` from `@expo-google-fonts/noto-sans`.
 *
 * The bytes are inlined as base64 so the renderer loads them identically in Node, vitest and a
 * Worker (which has no filesystem) — no per-platform branch or build-time generation step.
 *
 * Run with: pnpm --filter backend fonts:generate
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import subsetFont from 'subset-font';

const require = createRequire(import.meta.url);

/**
 * The Unicode ranges a rendered resume may contain. Subsetting cuts ~1.26 MB of font to ~0.4 MB.
 *
 * This is a product limit: a glyph outside these ranges is silently replaced by the shaper and then
 * caught by `preflightResumePdf`. Adding a script means adding its range and checking the size.
 *
 * Combining marks (U+0300–U+036F) are required because text often arrives decomposed (NFD) from
 * uploaded PDFs — `José` as `e` + U+0301.
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
 * Regenerate with \`pnpm --filter backend fonts:generate\` (see \`scripts/generateFonts.mts\`).
 *
 * Inlined so no filesystem is needed (Workers have none). Subsetted to Latin, Greek and Cyrillic
 * plus combining marks, punctuation and currency; a glyph outside that set fails
 * \`preflightResumePdf\`. Each render subsets again to the glyphs it uses.
 */
`;

await writeFile(
  new URL('../src/pdf/notoSansFonts.ts', import.meta.url),
  `${header}\n${chunks.join('\n\n')}\n`,
);
console.log('wrote src/pdf/notoSansFonts.ts');
