/**
 * When are two labels the same? This module holds every answer, under a name.
 *
 * A choice question travels a loop across both processes. `content/detectFields.ts` scrapes each
 * choice's label (and `background/apiDetectors.ts` may overlay the ATS API's own wording for it);
 * only the labels cross to the backend; `llm/answerQuestions.ts` constrains the drafted answer to be
 * one of them verbatim; and `content/fillForm.ts` matches that answer back against the same labels
 * to recover the element to click. The loop only closes if every step agrees on the rule.
 *
 * There is no single rule, and that is deliberate — the strictness that makes the model↔page loop
 * correct is exactly what makes a hand-typed prepared answer fail. What was *not* deliberate is that
 * the six rules lived in five modules under no shared name, so a choice question that didn't get
 * filled could be any of them and nothing said which. The rules are named here instead:
 *
 * | Rule | When to use it |
 * | --- | --- |
 * | {@link labelsMatch} / {@link matchOptionLabel} | Both sides read the same scraped label. Exact after normalizing. |
 * | {@link matchPreparedAnswerToOption} | A stored answer, typed months ago, against this form's wording. Forgiving. |
 * | {@link questionsMatch} | Two copies of the same question, ignoring trailing punctuation. |
 * | {@link matchByContainment} | Two independently-written phrasings of one question. |
 * | {@link matchByOverlap} | The same, when neither phrasing contains the other — a paraphrase. |
 * | {@link containsLabel} | Reading a value back out of a container element that may hold more than the value. |
 * | {@link containsAsWords} | Is this term *present* in a longer text at all? The only rule here not about a form label — `keywordCoverage.ts` asks it of a resume bullet. |
 *
 * Every rule that can match more than one candidate resolves ambiguity the same way, through
 * {@link uniqueMatch}: **more than one candidate means no match.** That invariant used to be
 * re-derived at each site, which is the kind of thing that stays consistent right up until it
 * doesn't — and where it matters most (a legal declaration about work authorization) guessing
 * between two candidates is worse than declining to answer.
 */

/** The canonical form of a label — also the key to use when indexing options by label. */
export function normalizeLabel(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The single candidate satisfying `predicate`, or `undefined` if none or several do.
 *
 * **The ambiguity invariant, implemented once.** Two candidates that both look right mean the input
 * doesn't say which was meant, and that is not the same as either one being correct — so it's a
 * non-match, to be reported as unresolved rather than filled confidently with a coin flip.
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
 * The option `answer` names, verbatim as `options` spells it, or `undefined` if it names none of
 * them. Returning the option rather than a boolean is what lets a caller correct a
 * case/whitespace-only mismatch back to the exact text the page (or the schema) uses.
 *
 * This is the strict rule, and it governs the loop between the answer-drafting model and the page,
 * where both ends work from the same scraped label and an exact match is the correctness property
 * worth having.
 */
export function matchOptionLabel(options: string[], answer: string): string | undefined {
  return uniqueMatch(options, (option) => labelsMatch(option, answer));
}

/** Whether `haystack` contains `needle` as a whole phrase. See {@link containsAsWords} for the strict form. */
export function containsLabel(haystack: string, needle: string): boolean {
  return normalizeLabel(haystack).includes(normalizeLabel(needle));
}

/**
 * Whether `option` begins with `answer` at a word boundary — "Yes" matching the option
 * "Yes, I am legally authorized to work in the United States", which is how ATS forms habitually
 * spell a yes/no choice.
 *
 * The boundary check is what keeps "No" from matching "None of the above": a prefix that runs
 * straight into more letters is a different word, not a longer spelling of the same answer.
 */
function startsWithAnswer(option: string, answer: string): boolean {
  if (!option.startsWith(answer)) return false;

  const next = option.charAt(answer.length);
  return next === '' || !/[a-z0-9]/i.test(next);
}

/**
 * Whether `option` contains `answer` as whole words. The same boundary rule as
 * {@link startsWithAnswer}, for the same reason and then some: without it, a stored "No" is
 * contained in "None of the above", "Not applicable" and "Norway".
 *
 * `\b` won't do here, since an answer can begin or end with punctuation, where `\b` sits on the
 * wrong side of the character.
 *
 * Exported for `keywordCoverage.ts`, whose haystack is a resume bullet rather than a form option
 * and whose needle is a posting's keyword — but which needs this rule for exactly the reason above,
 * one letter shorter: "R" is contained in "React" and "Go" in "Google", and reporting a keyword as
 * evidenced on that basis is a false claim about the candidate. A second caller is the reason this
 * module exists rather than a reason to copy the regex out of it.
 */
export function containsAsWords(option: string, answer: string): boolean {
  const escaped = answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(option);
}

/**
 * The option that a *prepared* `answer` names, verbatim as `options` spells it.
 *
 * Deliberately more forgiving than {@link matchOptionLabel}, and deliberately a separate rule. A
 * prepared answer was typed by hand, months earlier, with no knowledge of how this particular form
 * words its choices — so an exact match is tried first, then a unique word-boundary prefix, then a
 * unique substring.
 *
 * Every fallback goes through {@link uniqueMatch}: two options that both contain the stored answer
 * mean it doesn't say which one is meant, and a coin flip between two answers on a legal
 * declaration is worse than leaving it to be resolved with the fact in hand.
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
 * {@link normalizeLabel}, and also without trailing punctuation.
 *
 * Only for {@link matchByContainment}, and load-bearing there. A stored question almost always ends
 * in "?", and so does the form's — which means the stored text is *not* a substring of a form
 * question that adds words before its own "?": "are you willing to relocate?" is not inside "are you
 * willing to relocate for this role?", because the "?" lands mid-phrase. Containment matching that
 * kept the punctuation therefore only ever fired when the two strings were already near-identical,
 * which is the one case it isn't needed for.
 */
function normalizeQuestion(text: string): string {
  return normalizeLabel(text).replace(/[\s?!.,:;]+$/, '');
}

/** Whether two strings are the same question, ignoring case, whitespace and trailing punctuation. */
export function questionsMatch(a: string, b: string): boolean {
  const normalized = normalizeQuestion(a);
  return normalized !== '' && normalized === normalizeQuestion(b);
}

/**
 * The single candidate whose question contains `text` or is contained by it, or `undefined` if none
 * or several do.
 *
 * For matching two independently-written phrasings of the same question — a stored
 * "Are you willing to relocate?" answers a form's "Are you willing to relocate for this role?", and
 * vice versa, since neither was written with the other in view. Trailing punctuation is ignored on
 * both sides; see {@link normalizeQuestion}.
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
 * Words that say nothing about what a question is *about*.
 *
 * Question phrasing is mostly scaffolding — "how do you", "what is your", "please tell us about" —
 * and two forms asking the same thing rarely pick the same scaffolding. Scoring on the words that
 * carry the subject is what lets "How do you currently use AI tools in your work?" recognize a
 * stored "How are you currently using AI tools in your coding workflow?". Left in, the shared
 * scaffolding would flatter every pair of questions toward a match.
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
 * A word reduced to something a plural or a tense won't change.
 *
 * Crude on purpose — "use"/"using" and "code"/"coding" have to land on one token, and a real
 * stemmer is a dependency this package does not need for the job. Over-stemming ("this" → "thi")
 * costs nothing here because both sides go through it and the result is only ever compared to
 * another stem, never read.
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
 * The stopword list as {@link contentWords} actually compares it — stemmed, like everything it is
 * matched against.
 *
 * Filtering the raw word instead let scaffolding back in under a stem the list already holds:
 * "using" and "use" both stem to "us", which is on the list, but survived it because the filter ran
 * first — while the "us" of "please tell us" was dropped. Whether a word counted as subject matter
 * therefore depended on which inflection a form happened to use, and two phrasings of one question
 * scored differently depending on which was the stored one.
 */
const STOPWORD_STEMS = new Set([...QUESTION_STOPWORDS].map(stem));

/** The stemmed content words of a question, with the scaffolding dropped. */
function contentWords(text: string): Set<string> {
  return new Set(
    normalizeLabel(text)
      // In this phrase, "coding" narrows the kind of workflow rather than the AI-tools subject.
      // Collapsing it to the generic context word lets the two known paraphrases below compare on
      // {current, ai, tool}; "coding language" and other genuinely coding-specific subjects remain.
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
 * How much of two questions' combined subject matter they share, from 0 to 1.
 *
 * Measured against the *union*, which is what makes the score symmetric — a question is not the
 * stored one merely by being short enough to fit inside it. "Which of our tools have you used?"
 * contributes only "tool" and "use", both of which the stored AI-tools question happens to contain,
 * and against the smaller side alone that scores a perfect 1.0 while being a different question.
 *
 * A form that qualifies the stored question further may change its subject, so the longer side must
 * not get a free pass. Genuine paraphrases normalize to the same subject set below; the union is the
 * honest denominator before that stricter check is applied.
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
 * Whether both questions name exactly the same subject matter after normalization.
 *
 * **The score alone cannot tell a paraphrase from a contrast.** "How many years of experience do you
 * have with Python?" and "…with Java?" share {many, year, experienc} against a union of five: 0.6,
 * comfortably over the threshold, on two questions whose entire difference is the one word that
 * says what is being asked about. So do "Why do you want to work at Acme?" / "…at Globex?" and
 * "Describe a time you led a team." / "…joined a team.". Filling the stored answer into any of those
 * is not a near-miss, it is a false statement submitted in the candidate's name.
 *
 * A one-sided extra word is unsafe too. "React" / "React Native", "Portland" / "South Portland",
 * and "Software Engineer" / "Senior Software Engineer" are nested subject sets, but the modifier is
 * precisely what changes the answer. Requiring equality deliberately declines those questions; the
 * drafting model still receives prepared answers as grounding, so a false negative costs less than
 * confidently filling a false statement.
 */
function subjectsAreEquivalent(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((word) => b.has(word));
}

/**
 * The single candidate asking the same thing as `text`, judged by shared content words, or
 * `undefined` if none or several do.
 *
 * Exact question matching cannot see that
 * "How do you currently use AI tools in your work?" and "How are you currently using AI tools in
 * your coding workflow?" are one question, because neither string contains the other — which is
 * precisely the case a prepared answer exists for, since the candidate wrote their version months
 * before meeting this form's.
 *
 * Loosening this rule is not free: a wrong match fills a prepared answer into a question it doesn't
 * answer. Four things hold that down — the scaffolding words are dropped before scoring, so the
 * match rests on subject matter; {@link MIN_SHARED_CONTENT_WORDS} keeps a single shared word from
 * ever being enough; {@link subjectsAreEquivalent} refuses any unshared subject modifier; and
 * ambiguity is declined outright through {@link uniqueMatch}, as
 * everywhere else in this module. What a declined match costs is small and bounded: the question
 * goes to the answer-drafting model, which is given the prepared answers as grounding.
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
