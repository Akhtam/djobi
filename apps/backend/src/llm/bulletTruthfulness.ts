/**
 * Bullet Truthfulness: checks that a rewritten bullet's numbers and proper-noun-like terms already
 * appear in the source bullet it rewrote. If not, the source text is used verbatim — the
 * candidate's own sentence can never be an invented claim. Deterministic, no model call.
 *
 * Cannot catch qualitative inventions built from existing words ("single-handedly" added to "led").
 */
import { containsAsWords, normalizeLabel } from '@djobi/shared';

/** Digit sequences, with an optional decimal/thousands separator and a trailing `%`, `x` or `+`. */
function numberClaims(text: string): string[] {
  return text.match(/\d[\d,.]*(%|x|\+)?/gi) ?? [];
}

/**
 * Abbreviations whose period doesn't end a sentence ("Corp.", "Dr."), so the next capitalized word
 * still counts as a claim.
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'corp',
  'no',
  'vol',
  'approx',
  'dept',
  'univ',
  'gov',
]);

/** Sentences split on `.`/`!`/`?` plus whitespace, except after a known abbreviation. */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const boundary = /([.!?])\s+/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text))) {
    const precedingWord = text.slice(start, match.index).match(/([A-Za-z]+)$/)?.[1] ?? '';
    if (match[1] === '.' && ABBREVIATIONS.has(precedingWord.toLowerCase())) continue;

    const end = match.index + match[0].length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  sentences.push(text.slice(start));
  return sentences;
}

/**
 * Capitalized words that don't start a sentence — a cheap proxy for named technologies, products or
 * metric labels (`Kubernetes`, `Q3`).
 */
function properNounLikeClaims(text: string): string[] {
  const claims: string[] = [];
  for (const sentence of splitSentences(text)) {
    sentence
      .split(/\s+/)
      .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
      .forEach((word, index) => {
        if (index === 0 || word.length < 2) return;
        if (/^[A-Z]/.test(word)) claims.push(word);
      });
  }
  return claims;
}

/**
 * Whether `claim` appears in `haystack`, or — for a hyphenated compound like "Kubernetes-based" —
 * its bare form does.
 */
function claimIsGrounded(haystack: string, claim: string): boolean {
  if (containsAsWords(haystack, normalizeLabel(claim))) return true;

  const segments = claim.split('-').filter((segment) => segment.length >= 2);
  return (
    segments.length > 1 &&
    segments.some((segment) => containsAsWords(haystack, normalizeLabel(segment)))
  );
}

/**
 * Whether every claim `rewrite` makes beyond plain wording already appears somewhere in `source`.
 */
function isTruthfulRewrite(rewrite: string, source: string): boolean {
  const haystack = normalizeLabel(source);
  const properNounsMatch = properNounLikeClaims(rewrite).every((claim) =>
    claimIsGrounded(haystack, claim),
  );
  // Substring, not whole-word: numbers are often glued to units ("400ms").
  const numbersMatch = numberClaims(rewrite).every((claim) =>
    haystack.includes(normalizeLabel(claim)),
  );
  return properNounsMatch && numbersMatch;
}

/**
 * @returns `rewrite` if every number and proper-noun-like term in it traces to `source`; otherwise
 *   `source` verbatim.
 */
export function verifyBulletRewrite(rewrite: string, source: string): string {
  return isTruthfulRewrite(rewrite, source) ? rewrite : source;
}
