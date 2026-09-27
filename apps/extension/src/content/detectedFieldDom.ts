/**
 * How a **Detected Field** maps back onto the live DOM — the single copy of the rules detection and
 * filling must share:
 *
 * - {@link choicesIn}: what counts as a choice (native inputs, else ARIA choices).
 * - {@link choiceLabel}: a choice's visible text.
 * - {@link listboxFor}: the `aria-controls`/`aria-owns` link to a combobox's listbox.
 * - {@link resolveChoice}: finding the element for an answer, scoped to the field.
 *
 * `fillForm.ts` gets an element or a stated reason ({@link ChoiceResolution}); it re-derives
 * nothing.
 */
import { labelsMatch, optionFor, uniqueMatch, type DetectedField } from '@djobi/shared';
import { collapseWhitespace, getSignal, isInstanceOf } from './pageSignals';

/**
 * Native choice inputs — one question's mutually-exclusive (radio) or multi-select (checkbox)
 * answers.
 */
export const NATIVE_CHOICE_SELECTOR = 'input[type="radio"], input[type="checkbox"]';

/**
 * ARIA-built choices (`role="radio"`, `role="checkbox"`, `button[aria-pressed]`). Only searched
 * inside a known choice group, so ordinary page buttons are never taken for answers.
 */
const ARIA_CHOICE_SELECTOR = '[role="radio"], [role="checkbox"], button[aria-pressed]';

/** The choices in a group: its native inputs, or its ARIA stand-ins when it has no native ones. */
export function choicesIn(container: Element): Element[] {
  const native = Array.from(container.querySelectorAll(NATIVE_CHOICE_SELECTOR));
  if (native.length > 0) return native;
  return Array.from(container.querySelectorAll(ARIA_CHOICE_SELECTOR));
}

/**
 * One choice's visible answer text — used both for a detected option's `label` and to re-read
 * choices at fill time. Always whitespace-collapsed, like every other choice label, so it matches
 * the API's wording in `apiDetectors.mergeOptions`.
 */
export function choiceLabel(doc: Document, el: Element): string {
  if (isInstanceOf(el, 'HTMLInputElement'))
    return getSignal(doc, el) || collapseWhitespace(el.value);
  return collapseWhitespace(el.getAttribute('aria-label') ?? el.textContent ?? '');
}

/**
 * The listbox `trigger` names via `aria-controls`/`aria-owns`, or `null`. `null` (names none)
 * differs from an empty listbox — see {@link optionScopeFor}.
 */
export function listboxFor(doc: Document, trigger: Element): Element | null {
  const controlsId = trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns');
  return controlsId ? doc.getElementById(controlsId) : null;
}

/**
 * Resolves a Detected Field's `selector` to its matching DOM element, or `null` if unresolvable.
 */
export function resolveField<T extends Element = HTMLElement>(
  doc: Document,
  field: DetectedField,
): T | null {
  return doc.querySelector<T>(field.selector);
}

/**
 * Where this field's recorded option elements may live; `null` when nothing narrower than the
 * document is known.
 *
 * **The ownership check.** A recorded selector is `#<page-id>` when the page supplied an id, and
 * resolving that document-wide can hit another field's element (duplicate ids, two `#yes`) — which
 * the verifier would then report as success. Scoped per `elementRole`: a combobox to the listbox it
 * names (often portal-mounted outside the trigger). A combobox naming none falls back to the
 * document — a known hole, confined to this function.
 */
function optionScopeFor(doc: Document, field: DetectedField): Element | Document | null {
  const el = resolveField(doc, field);
  if (!el) return null;

  // A `<select>`'s options are its own descendants; a group's choices are inside its container.
  // Both are `field.selector`, so one lookup covers them.
  if (field.elementRole !== 'combobox') return el;

  // Unsafe with two comboboxes open at once: the first text match wins. Nothing narrower exists.
  return listboxFor(doc, el) ?? doc;
}

/**
 * An element for a drafted answer, or why there isn't one. Reasons are kept distinct so the Fill
 * Step can eventually report them differently.
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
 * The element for `answer` among `candidates`, by {@link choiceLabel} — for choices recorded
 * without a selector (from an API schema, or a listbox that mounts on open).
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
 * Choice elements to scan when no recorded selector resolved: a combobox's `[role="option"]`s, a
 * `<select>`'s own `.options` (realm-safe), or a group's {@link choicesIn}.
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
 * The element to act on for `answer`, resolved within the field's scope: the recorded selector
 * first, then a label scan. Synchronous — `fillForm.fillCombobox` polls it for late-mounting
 * options.
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
