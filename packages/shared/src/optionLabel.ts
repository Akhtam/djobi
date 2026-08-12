/**
 * The option-label protocol: how a Question Answer is matched back to the Detected Field option it
 * names.
 *
 * A choice question travels a loop across both processes. `content/detectFields.ts` scrapes each
 * choice's label from the page (and `background/apiDetectors.ts` may overlay the ATS API's own
 * wording for it); only the labels cross to the backend; `llm/answerQuestions.ts` constrains the
 * drafted answer to be one of them verbatim; and `content/fillForm.ts` matches that answer back
 * against the same labels to recover the element to click. The loop only closes if all three agree
 * on when two labels are "the same" — and they each used to carry a private
 * `text.trim().toLowerCase()` to decide it. Three copies of one contract, in two processes, with
 * nothing linking them: change one and the others silently stop matching, which shows up as a
 * choice question that just doesn't get filled.
 *
 * Loosening the rule here (collapsing internal whitespace, say, or stripping a trailing required
 * marker) now moves all three at once. That's the point of it living here.
 */

/** The canonical form of a label — also the key to use when indexing options by label. */
export function normalizeLabel(text: string): string {
  return text.trim().toLowerCase();
}

/** Whether two labels name the same choice. */
export function labelsMatch(a: string, b: string): boolean {
  return normalizeLabel(a) === normalizeLabel(b);
}

/**
 * The option `answer` names, verbatim as `options` spells it, or `undefined` if it names none of
 * them. Returning the option rather than a boolean is what lets a caller correct a
 * case/whitespace-only mismatch back to the exact text the page (or the schema) uses.
 */
export function matchOptionLabel(options: string[], answer: string): string | undefined {
  return options.find((option) => labelsMatch(option, answer));
}
