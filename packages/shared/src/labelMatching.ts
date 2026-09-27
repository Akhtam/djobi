/**
 * When two labels count as the same — every rule, named.
 *
 * A choice answer loops across processes: `detectFields.ts` scrapes option labels (maybe overlaid
 * by `apiDetectors.ts`), `answerQuestions.ts` constrains the model to them verbatim, and
 * `fillForm.ts` matches the answer back to an element. Strictness that makes that loop correct
 * would break hand-typed prepared answers, so there are several rules:
 *
 * | Rule | Use |
 * | --- | --- |
 * | {@link labelsMatch} / {@link matchOptionLabel} | Same scraped label on both sides. Exact. |
 * | {@link matchPreparedAnswerToOption} | A stored answer vs. this form's wording. Forgiving. |
 * | {@link questionsMatch} | Same question, ignoring trailing punctuation. |
 * | {@link matchByContainment} | Two phrasings where one contains the other. |
 * | {@link matchByOverlap} | A paraphrase — neither contains the other. |
 * | {@link containsLabel} | A value inside a container that may hold more text. |
 * | {@link containsAsWords} | A term present in longer text (used by `keywordCoverage.ts`). |
 *
 * Every multi-candidate rule resolves through {@link uniqueMatch}: **more than one candidate means
 * no match** — guessing on e.g. a work-authorization declaration is worse than declining.
 */

/** The canonical form of a label — also the key to use when indexing options by label. */
export function normalizeLabel(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * A keyword's canonical form for aggregation and matching; spaces and dashes are interchangeable.
 */
export function normalizeKeyword(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u2010-\u2015-]+/g, ' ')
    .trim();
}

/**
 * The single candidate satisfying `predicate`, or `undefined` if none or several do — ambiguity is
 * reported as unresolved, never resolved by a coin flip.
 */
export function uniqueMatch<T>(
  candidates: readonly T[],
  predicate: (candidate: T) => boolean,
): T | undefined {
  const matches = candidates.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether two labels name the same choice. Exact, after normalizing. */
export function labelsMatch(a: string, b: string): boolean {
  return normalizeLabel(a) === normalizeLabel(b);
}

/**
 * The option `answer` names, spelled as `options` spells it, or `undefined`. The strict rule for
 * the model↔page loop; returning the option lets callers fix case/whitespace mismatches.
 */
export function matchOptionLabel(options: string[], answer: string): string | undefined {
  return uniqueMatch(options, (option) => labelsMatch(option, answer));
}

/**
 * Whether `haystack` contains `needle` as a whole phrase. See {@link containsAsWords} for the
 * strict form.
 */
export function containsLabel(haystack: string, needle: string): boolean {
  return normalizeLabel(haystack).includes(normalizeLabel(needle));
}

/**
 * Whether `option` starts with `answer` at a word boundary ("Yes" → "Yes, I am authorized…"), so
 * "No" never matches "None of the above".
 */
function startsWithAnswer(option: string, answer: string): boolean {
  if (!option.startsWith(answer)) return false;

  const next = option.charAt(answer.length);
  return next === '' || !/[a-z0-9]/i.test(next);
}

/**
 * Whether `option` contains `answer` as whole words, so "No" isn't found in "Norway" (or, for
 * `keywordCoverage.ts`, "Go" in "Google"). Not `\b`, since answers can start or end with
 * punctuation.
 */
export function containsAsWords(option: string, answer: string): boolean {
  const escaped = answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(option);
}

/**
 * The option a hand-typed prepared `answer` names, spelled as `options` spells it. Tries exact,
 * then a unique word-boundary prefix, then a unique substring — every fallback via {@link
 * uniqueMatch}.
 */
export function matchPreparedAnswerToOption(options: string[], answer: string): string | undefined {
  const target = normalizeLabel(answer);
  if (!target) return undefined;

  const exact = uniqueMatch(options, (option) => normalizeLabel(option) === target);
  if (exact) return exact;

  const prefixed = uniqueMatch(options, (option) =>
    startsWithAnswer(normalizeLabel(option), target),
  );
  if (prefixed) return prefixed;

  return uniqueMatch(options, (option) => containsAsWords(normalizeLabel(option), target));
}

/**
 * {@link normalizeLabel} without trailing punctuation, for {@link matchByContainment}: otherwise
 * "relocate?" is never inside "relocate for this role?".
 */
function normalizeQuestion(text: string): string {
  return normalizeLabel(text).replace(/[\s?!.,:;]+$/, '');
}

/**
 * Whether two strings are the same question, ignoring case, whitespace and trailing punctuation.
 */
export function questionsMatch(a: string, b: string): boolean {
  const normalized = normalizeQuestion(a);
  return normalized !== '' && normalized === normalizeQuestion(b);
}

/**
 * The single candidate whose question contains `text` or is contained by it, ignoring trailing
 * punctuation — e.g. "Willing to relocate?" vs. "Willing to relocate for this role?".
 */
export function matchByContainment<T>(
  candidates: readonly T[],
  labelOf: (candidate: T) => string,
  text: string,
): T | undefined {
  const target = normalizeQuestion(text);
  if (!target) return undefined;

  return uniqueMatch(candidates, (candidate) => {
    const label = normalizeQuestion(labelOf(candidate));
    return label !== '' && (label.includes(target) || target.includes(label));
  });
}

/**
 * Question scaffolding ("how do you", "please tell us about") that says nothing about the subject.
 * Dropped so overlap scoring rests on subject words only.
 */
const QUESTION_STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'brief',
  'briefly',
  'by',
  'can',
  'could',
  'describe',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'here',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'let',
  'like',
  'may',
  'me',
  'much',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'role',
  'share',
  'should',
  'so',
  'some',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'while',
  'who',
  'will',
  'with',
  'work',
  'would',
  'you',
  'your',
  'yours',
]);

/**
 * A crude stem so "use"/"using" and "code"/"coding" collide. Over-stemming is harmless: stems are
 * only compared with other stems.
 */
function stem(word: string): string {
  let stemmed = word;
  for (const suffix of ['ing', 'ed', 'es', 'ly', 's']) {
    if (stemmed.length >= suffix.length + 2 && stemmed.endsWith(suffix)) {
      stemmed = stemmed.slice(0, -suffix.length);
      break;
    }
  }
  return stemmed.length > 2 && stemmed.endsWith('e') ? stemmed.slice(0, -1) : stemmed;
}

/**
 * Stopwords stemmed, so filtering happens on stems — otherwise whether a word counted as subject
 * depended on its inflection.
 */
const STOPWORD_STEMS = new Set([...QUESTION_STOPWORDS].map(stem));

/** The stemmed content words of a question, with the scaffolding dropped. */
function contentWords(text: string): Set<string> {
  return new Set(
    normalizeLabel(text)
      // Here "coding" narrows the workflow, not the AI-tools subject; map it to the generic word.
      .replace(/\bcoding workflow\b/g, 'work')
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '')
      .map(stem)
      .filter((word) => !STOPWORD_STEMS.has(word)),
  );
}

/** Below this share of the two questions' combined subject matter, they are not one question. */
const OVERLAP_THRESHOLD = 0.5;
/** Fewer shared content words than this is a coincidence, whatever the ratio says. */
const MIN_SHARED_CONTENT_WORDS = 2;

/**
 * Shared subject words over the union, 0–1. The union keeps it symmetric: a short question isn't a
 * match just because it fits inside a longer one.
 */
function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  // Two questions can share one content word and be about different things — "What country are you
  // based in?" and "What state are you based in?" share "based". One word is a coincidence.
  if (shared < MIN_SHARED_CONTENT_WORDS) return 0;
  return shared / (a.size + b.size - shared);
}

/**
 * Whether both questions have exactly the same subject set. Overlap alone can't tell a paraphrase
 * from a contrast ("…with Python?" vs "…with Java?"), and a one-sided modifier ("React" vs
 * "React Native") changes the answer too. A false negative just falls back to the model.
 */
function subjectsAreEquivalent(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((word) => b.has(word));
}

/**
 * The single candidate asking the same thing as `text` by subject words, or `undefined` — for
 * paraphrases with no shared substring ("How do you use AI tools in your work?" vs. "How are you
 * using AI tools in your coding workflow?").
 *
 * Guarded by stopword removal, {@link MIN_SHARED_CONTENT_WORDS}, {@link subjectsAreEquivalent} and
 * {@link uniqueMatch}. A declined match only means the model drafts it with prepared answers as
 * grounding.
 */
export function matchByOverlap<T>(
  candidates: readonly T[],
  labelOf: (candidate: T) => string,
  text: string,
): T | undefined {
  const target = contentWords(text);
  if (target.size === 0) return undefined;

  return uniqueMatch(candidates, (candidate) => {
    const stored = contentWords(labelOf(candidate));
    return (
      overlapScore(stored, target) >= OVERLAP_THRESHOLD && subjectsAreEquivalent(stored, target)
    );
  });
}
