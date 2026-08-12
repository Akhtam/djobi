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
 * | {@link matchByContainment} | Two independently-written phrasings of one question. |
 * | {@link containsLabel} | Reading a value back out of a container element that may hold more than the value. |
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
  return options.find((option) => labelsMatch(option, answer));
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
 */
function containsAsWords(option: string, answer: string): boolean {
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

  const exact = options.find((option) => normalizeLabel(option) === target);
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
