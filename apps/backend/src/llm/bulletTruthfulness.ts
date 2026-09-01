/**
 * Bullet Truthfulness: the last check a tailored bullet's *rewritten text* passes through before it
 * reaches a resume.
 *
 * `reconcileResume` already guarantees a kept bullet traces to a real source pointer — it cannot
 * invent a bullet from nothing. What it does not guarantee is that a rewrite of a real bullet stayed
 * truthful: "Cut latency by 40%" is a legitimate concision of a source bullet that never states a
 * number, exactly as easily as it is an invented metric. This module is the difference — a
 * deterministic check, no model call, that a rewrite's numbers and proper-noun-like terms (metrics,
 * technologies, scope, named outcomes) already appear somewhere in the bullet it rewrote.
 *
 * **The fallback is the source text itself, verbatim** — not a rejection, not a second model call.
 * The candidate's own sentence can never read as an invented claim, because it isn't one; reverting
 * loses the model's phrasing, never the underlying fact. This is the same shape of guarantee
 * `reconcileResume` already gives at the bullet-selection level, extended one level down to a
 * bullet's own wording.
 *
 * **What this cannot see.** A rewrite that invents a *qualitative* claim using only words already in
 * the source — "single-handedly" added to a bullet that already says "led" — passes through
 * unchanged, since nothing here parses meaning, only which literal tokens are new. Numbers and
 * capitalized terms are what's checkable without a second model call; scope language is not.
 */
import { containsAsWords, normalizeLabel } from '@djobi/shared';

/** Digit sequences, with an optional decimal/thousands separator and a trailing `%`, `x` or `+`. */
function numberClaims(text: string): string[] {
  return text.match(/\d[\d,.]*(%|x|\+)?/gi) ?? [];
}

/**
 * Titles and honorifics that end in a period without ending the sentence — "Corp.", "Dr." — so the
 * capitalized word right after one is not mistaken for a sentence-initial word and excluded from the
 * claims check.
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

/**
 * `text` split into sentences on `.`/`!`/`?` followed by whitespace — except a `.` right after a
 * known abbreviation ("Corp.", "Dr."), which does not end the sentence, since the word following it
 * is a continuation of the current one, not a new sentence's opening word.
 */
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
 * Capitalized words that aren't the first word of their sentence — a cheap proxy for "a named
 * technology, product, company, or metric label" (`Kubernetes`, `Redis`, `Q3`), the kind of specific
 * a rewrite should not be introducing on its own. Sentence-initial capitalization is ordinary English
 * and carries no such claim.
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
 * Whether `claim` traces back to `haystack` — as itself, or, for a hyphenated compound like
 * "Kubernetes-based", as its bare form. The compound as a whole is a rewrite's own phrasing, not a
 * new claim, as long as the proper noun inside it ("Kubernetes") is one the source already makes.
 */
function claimIsGrounded(haystack: string, claim: string): boolean {
  if (containsAsWords(haystack, normalizeLabel(claim))) return true;

  const segments = claim.split('-').filter((segment) => segment.length >= 2);
  return (
    segments.length > 1 &&
    segments.some((segment) => containsAsWords(haystack, normalizeLabel(segment)))
  );
}

/** Whether every claim `rewrite` makes beyond plain wording already appears somewhere in `source`. */
function isTruthfulRewrite(rewrite: string, source: string): boolean {
  const haystack = normalizeLabel(source);
  const properNounsMatch = properNounLikeClaims(rewrite).every((claim) =>
    claimIsGrounded(haystack, claim),
  );
  // Not word-boundary matched like the term check above: a number is routinely glued to a unit
  // ("400ms", "1.8s") with no non-alphanumeric character between them for containsAsWords to anchor
  // on, which would reject every truthful number-plus-unit rewrite as if it were invented.
  const numbersMatch = numberClaims(rewrite).every((claim) =>
    haystack.includes(normalizeLabel(claim)),
  );
  return properNounsMatch && numbersMatch;
}

/**
 * Verifies one rewritten bullet against the source bullet it rewrote.
 *
 * @returns The rewrite unchanged when every number and proper-noun-like term in it traces back to
 *   `source`; `source` itself, verbatim, otherwise.
 */
export function verifyBulletRewrite(rewrite: string, source: string): string {
  return isTruthfulRewrite(rewrite, source) ? rewrite : source;
}
