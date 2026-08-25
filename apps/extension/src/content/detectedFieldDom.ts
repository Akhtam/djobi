/**
 * How a **Detected Field** maps back onto the live DOM.
 *
 * The two halves of the Detected Field round-trip — `detectFields.ts` producing them and
 * `fillForm.ts` acting on them — have to agree on four things, and each one used to be written
 * twice, in two files, with nothing checking the copies still matched:
 *
 * - **One selector grammar.** {@link choicesIn} decides what counts as a choice. `fillForm.ts` used
 *   to hand-concatenate the same two constants into one literal, which is not the same rule: this
 *   prefers native inputs and falls back to ARIA *only when there are none*, where the literal
 *   queried both at once. On a form rendering an `<input type="radio">` beside an ARIA proxy, the
 *   fill saw two same-labelled choices, matched neither, and left the field blank.
 * - **One label ladder.** {@link choiceLabel}, over `pageSignals.getSignal`. Deriving a choice's
 *   text a second way at fill time is how the two halves come to disagree.
 * - **One listbox link.** {@link listboxFor} — `aria-controls`/`aria-owns`. Detection followed it to
 *   record a combobox's options; filling followed it again to find them live; they were separate
 *   implementations of one rule.
 * - **One resolution, and it is scoped.** {@link resolveChoice} — see the ownership note there.
 *
 * `fillForm.ts` asks this module for an element and gets one, or gets a stated reason
 * ({@link ChoiceResolution}). It no longer re-derives anything.
 */
import { labelsMatch, optionFor, uniqueMatch, type DetectedField } from '@djobi/shared';
import { collapseWhitespace, getSignal, isInstanceOf } from './pageSignals';

/** Native choice inputs — one question's mutually-exclusive (radio) or multi-select (checkbox) answers. */
export const NATIVE_CHOICE_SELECTOR = 'input[type="radio"], input[type="checkbox"]';

/**
 * Choices built out of ARIA rather than inputs — a `<button role="radio">`, a `<div role="checkbox">`,
 * or a pressed-state toggle button. Only ever looked for *inside* a container already identified as
 * a choice group, so ordinary page buttons (submit, nav, "add another") can't be mistaken for answers.
 */
const ARIA_CHOICE_SELECTOR = '[role="radio"], [role="checkbox"], button[aria-pressed]';

/** The choices in a group: its native inputs, or its ARIA stand-ins when it has no native ones. */
export function choicesIn(container: Element): Element[] {
  const native = Array.from(container.querySelectorAll(NATIVE_CHOICE_SELECTOR));
  if (native.length > 0) return native;
  return Array.from(container.querySelectorAll(ARIA_CHOICE_SELECTOR));
}

/**
 * One choice's visible answer text.
 *
 * The one derivation. Detection records it as a {@link FieldOption}'s `label`, and
 * {@link resolveChoiceAmong} re-reads it from the live DOM for a choice that carried no recorded
 * selector. Both go through here, because deriving it a second way is how the two halves come to
 * disagree — which is what `fillForm.ts` importing this from `detectFields.ts` used to invite.
 *
 * Every branch ends in {@link collapseWhitespace}, as does every other place a choice label is produced
 * ({@link resolveComboboxOptions}, {@link resolveSelectOptions}). Option labels used to skip it
 * while field labels didn't, and the asymmetry was silently expensive: a multi-line
 * `<li role="option">` kept its newline, so the key `apiDetectors.mergeOptions` builds from it never
 * matched the API's wording of the same choice, and that option was permanently demoted from "click
 * this element" to "hope the text matches at fill time".
 */
export function choiceLabel(doc: Document, el: Element): string {
  if (isInstanceOf(el, 'HTMLInputElement'))
    return getSignal(doc, el) || collapseWhitespace(el.value);
  return collapseWhitespace(el.getAttribute('aria-label') ?? el.textContent ?? '');
}

/**
 * The listbox `trigger` names via `aria-controls`/`aria-owns`, or `null` when it names none.
 *
 * The single implementation of that link. Detection follows it to record a combobox's options;
 * filling follows it to find them live, and to know where a recorded option is *allowed* to be. The
 * two used to be separate copies, and the fill-side one carried a comment admitting as much.
 *
 * `null` rather than an empty array, because "this widget names no listbox" and "the listbox is
 * empty" are different facts with different fallbacks — see {@link optionScopeFor}.
 */
export function listboxFor(doc: Document, trigger: Element): Element | null {
  const controlsId = trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns');
  return controlsId ? doc.getElementById(controlsId) : null;
}

/** Resolves a Detected Field's `selector` to its matching DOM element, or `null` if unresolvable. */
export function resolveField<T extends Element = HTMLElement>(
  doc: Document,
  field: DetectedField,
): T | null {
  return doc.querySelector<T>(field.selector);
}

/**
 * Where this field's recorded option elements are allowed to live — `null` when nothing narrower
 * than the document can be established.
 *
 * **This is the ownership check.** A recorded option selector is `#<page-id>` whenever the element
 * carried an id of its own, because `detectFields`' tagger prefers a page-supplied `id` over writing
 * a `data-djobi-id` — so every unsafe selector is one Djobi did not mint. Resolving those
 * document-wide returns the *first* match in document order, which on a form with duplicate ids (or
 * two questions whose choices are both `#yes`) is an element belonging to a different field
 * entirely. The click then lands there, and — because the verifier re-reads the element it just
 * clicked — the wrong write reports itself as a success.
 *
 * Scoping is per `elementRole` and cannot be a blanket "inside the field's container": a combobox's
 * listbox is routinely portal-mounted *outside* the trigger, which is the whole reason
 * {@link listboxFor} exists. So a combobox is scoped to the listbox it names, and only a combobox
 * that names none falls back to the document. That last case is an acknowledged hole rather than a
 * fixed one — it is unchanged in breadth from the fill-side lookup this replaced, and the point of
 * this function is that it is now the *only* place left with it.
 */
function optionScopeFor(doc: Document, field: DetectedField): Element | Document | null {
  const el = resolveField(doc, field);
  if (!el) return null;

  // A `<select>`'s options are its own descendants; a group's choices are inside its container.
  // Both are `field.selector`, so one lookup covers them.
  if (field.elementRole !== 'combobox') return el;

  // Unsafe on a form with two comboboxes open or portal-mounted at once — the first text match
  // wins, and it may belong to a different field. Narrowing it is not possible without a link the
  // page declined to make.
  return listboxFor(doc, el) ?? doc;
}

/**
 * What the Fill Step gets back when it asks for the element behind a drafted answer: an element, or
 * a reason there isn't one.
 *
 * The reasons are distinguished because they mean different things to a candidate — a field the
 * page no longer has is not the same problem as an answer that names two choices at once — and the
 * Fill Step currently collapses all of them into "not filled". Carrying the reason here is what
 * lets that stop being true without touching this module again.
 */
export type ChoiceResolution =
  | { readonly ok: true; readonly element: HTMLElement }
  | {
      readonly ok: false;
      readonly reason: 'field-missing' | 'ambiguous-answer' | 'no-such-choice';
    };

/** Whether the recorded option list itself gives more than one meaning to this answer. */
function isAmbiguous(field: DetectedField, answer: string): boolean {
  return (field.options?.filter((option) => labelsMatch(option.label, answer)).length ?? 0) > 1;
}

/**
 * The element for `answer` among `candidates`, matched on {@link choiceLabel}.
 *
 * The fallback path, for a choice that had no element to record at detection time — one known only
 * from an ATS API schema, or from a listbox that only mounts once opened.
 */
function resolveChoiceAmong(
  doc: Document,
  candidates: readonly Element[],
  answer: string,
): ChoiceResolution {
  const match = uniqueMatch(candidates, (choice) => labelsMatch(choiceLabel(doc, choice), answer));
  return match
    ? { ok: true, element: match as HTMLElement }
    : { ok: false, reason: 'no-such-choice' };
}

/**
 * The choice elements to scan when no recorded selector resolved.
 *
 * Role-dependent, because the three widget shapes express a choice differently: a combobox's are
 * `[role="option"]` inside its listbox, a `<select>`'s are its own `<option>`s, and a group's are
 * whatever {@link choicesIn}'s grammar admits. Reading a select's `.options` rather than querying
 * `'option'` keeps the realm guarantee — it is a live collection off the element itself, with no
 * constructor identity involved.
 */
function choiceCandidatesIn(field: DetectedField, scope: Element | Document): readonly Element[] {
  if (field.elementRole === 'combobox')
    return Array.from(scope.querySelectorAll('[role="option"]'));

  // Every other scope is the field's own element — {@link optionScopeFor} widens to the document
  // for a combobox alone, and that case returned above.
  const el = scope as Element;
  if (isInstanceOf(el, 'HTMLSelectElement')) return Array.from(el.options);
  return choicesIn(el);
}

/**
 * The element to act on for `answer` on `field`, resolved **within the field's own scope**.
 *
 * The recorded selector first, scoped per {@link optionScopeFor}, then a label scan over the
 * candidates that scope admits. All three widget shapes go through here.
 *
 * Synchronous, and that is deliberate: a combobox's options may not have mounted yet, so
 * `fillForm.fillCombobox` calls this repeatedly inside a poll it budgets itself. The rule for
 * *what matches* lives here; the rule for *how long to wait* lives with the caller that configures
 * it.
 */
export function resolveChoice(
  doc: Document,
  field: DetectedField,
  answer: string,
): ChoiceResolution {
  if (isAmbiguous(field, answer)) return { ok: false, reason: 'ambiguous-answer' };

  const scope = optionScopeFor(doc, field);
  if (!scope) return { ok: false, reason: 'field-missing' };

  const selector = optionFor(field, answer)?.selector;
  const recorded = selector ? scope.querySelector<HTMLElement>(selector) : null;
  if (recorded) return { ok: true, element: recorded };

  return resolveChoiceAmong(doc, choiceCandidatesIn(field, scope), answer);
}
