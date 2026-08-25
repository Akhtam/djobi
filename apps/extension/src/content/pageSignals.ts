/**
 * How this extension reads an ATS page: which DOM classes an element belongs to, and what text
 * names it.
 *
 * Split out of `detectFields.ts` because it was never detection-only. `detect.ts` already imported
 * {@link getSignal} from there, and `detectedFieldDom.ts` needs the same label ladder to recover a
 * choice's element at fill time — so the Fill Step was reaching into the detection module for
 * primitives, or worse, deriving them a second way and drifting.
 *
 * Everything here is **realm-safe**: every DOM-class test goes through {@link isInstanceOf} rather
 * than this realm's globals, so a document from an `iframe.contentDocument` reads identically to
 * this one. That guarantee is the module's whole reason for existing as a shared layer — it used to
 * hold on the detection side and silently not on the filling side.
 */

/** Field elements that carry data a candidate fills in, as opposed to buttons/hidden inputs. */
export type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Whether `el` is an instance of the named DOM class **in its own document's realm**.
 *
 * A bare `el instanceof HTMLInputElement` tests against the constructors of whichever realm this
 * module was loaded into. An element from another document — `iframe.contentDocument`, which
 * `detectFields(doc)` accepts without complaint since its parameter is just `Document` — comes from
 * a different realm with different constructor identities, so every such test returns false. The
 * failure is silent and total: fields lose their required flags, choice groups are typed as
 * radiogroups regardless, selects report no options. Resolving the constructor from
 * `el.ownerDocument.defaultView` asks the question in the realm the element actually belongs to,
 * and is identical to the global in the ordinary same-realm case.
 */
export function isInstanceOf<
  K extends 'HTMLInputElement' | 'HTMLTextAreaElement' | 'HTMLSelectElement',
>(el: Element, className: K): el is InstanceType<(Window & typeof globalThis)[K]> {
  const view = el.ownerDocument.defaultView;
  return view ? el instanceof view[className] : false;
}

/** Whether `el` is one of the three elements carrying `required`, `labels` and a validity state. */
export function isFormControl(el: Element): el is FieldElement {
  return (
    isInstanceOf(el, 'HTMLInputElement') ||
    isInstanceOf(el, 'HTMLTextAreaElement') ||
    isInstanceOf(el, 'HTMLSelectElement')
  );
}

/**
 * A signal collapsed to one line, the way the accessible-name computation's "flat string" is.
 *
 * Label markup is routinely written across several source lines, so the raw `textContent` of a
 * perfectly ordinary label arrives as `"Are you legally\n      authorized to work"`. Every consumer
 * of a signal matches against it as prose — `KEYWORD_RULES` here, and `normalizeLabel` in
 * `background/apiDetectors.ts`, which pairs a DOM field with its ATS-API counterpart by label — so
 * an embedded newline silently defeats both.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Controls whose own text must not be read as part of a label that wraps them. */
export const NESTED_CONTROL_SELECTOR = 'input, textarea, select, button';

/**
 * A label's text, with any control it wraps excluded.
 *
 * HTML-AAM's naming step for form controls says to exclude the control's own value from the label
 * it is nested inside. That matters for the wrap-style association Lever uses: a `<select>` nested
 * in its own `<label>` contributes its selected option's text to the label's `textContent`, so a
 * pre-filled field's label reads "Country United States" and stops matching anything.
 */
export function labelText(label: Element): string {
  if (!label.querySelector(NESTED_CONTROL_SELECTOR))
    return collapseWhitespace(label.textContent ?? '');

  const copy = label.cloneNode(true) as Element;
  for (const control of copy.querySelectorAll(NESTED_CONTROL_SELECTOR)) control.remove();
  return collapseWhitespace(copy.textContent ?? '');
}

/**
 * Every `<label for>` pointing at `id`.
 *
 * **All** of them: HTML lets several labels name one control, and the accessible name concatenates
 * them in document order, where the previous `doc.querySelector('label[for=…]')` took whichever came
 * first and dropped the rest. That is the whole reason this reads the attribute instead — comparing
 * strings is simply the straightforward way to ask "which labels point here", not a workaround.
 *
 * Not a selector-safety fix: `label[for="question_123[]"]` is perfectly valid CSS, since brackets
 * are legal inside a quoted attribute value. (It's `#id` that needs `CSS.escape`, which
 * `tagger.locate` applies.)
 */
function labelsForId(doc: Document, id: string): Element[] {
  return Array.from(doc.querySelectorAll('label[for]')).filter(
    (label) => label.getAttribute('for') === id,
  );
}

/**
 * The `<label>` elements formally associated with `el`.
 *
 * For real form controls this is `HTMLElement.labels`, which implements both association forms
 * (`for=` and wrapping) exactly as the HTML spec defines them, and returns every associated label
 * rather than whichever one happens to come first in the document. ARIA widgets built on a `<div>`
 * have no `.labels`, so they keep the hand-rolled lookup.
 */
export function associatedLabels(doc: Document, el: Element): Element[] {
  if (isFormControl(el)) return Array.from(el.labels ?? []);

  const id = el.getAttribute('id');
  const explicit = id ? labelsForId(doc, id) : [];
  if (explicit.length > 0) return explicit;

  const wrapping = el.closest('label');
  return wrapping ? [wrapping] : [];
}

/** Concatenated `textContent` of every element referenced by a whitespace-separated id list. */
export function resolveIdRefs(doc: Document, idRefs: string): string {
  return collapseWhitespace(
    idRefs
      .split(/\s+/)
      .map((refId) => doc.getElementById(refId)?.textContent?.trim())
      .filter((text): text is string => !!text)
      .join(' '),
  );
}

/**
 * Ids no human wrote, which therefore read as noise rather than as a label.
 *
 * `getSignal` falls back to the `id` attribute as a last resort, which is fine for an authored id
 * like `work-authorization` but actively harmful for a generated one: react-select names its inner
 * input `react-select-3-input`, and React's `useId` produces `:r1:`. Either would otherwise be
 * handed to the answer-drafting model as the question to answer.
 */
const GENERATED_ID =
  /^:r[0-9a-z]*:$|(^|[-_])(react|radix|headlessui|mui|downshift|select)([-_]|$)/i;

/**
 * Signal text used to classify a field: its associated `<label>` text, an `aria-labelledby`
 * reference, `aria-label`, its wrapper's label, then `title` and attribute fallbacks.
 *
 * The `title`-before-`placeholder` ordering is HTML-AAM's for form controls (aria-* → label →
 * `title` → `placeholder`); the wrapper-label step in between is not from any spec, see
 * {@link wrappingFieldLabel}.
 */
export function getSignal(doc: Document, el: Element): string {
  const labels = associatedLabels(doc, el);
  if (labels.length > 0) {
    const text = collapseWhitespace(labels.map(labelText).join(' '));
    if (text) return text;
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const resolved = resolveIdRefs(doc, labelledBy);
    if (resolved) return resolved;
  }

  const ariaLabel = collapseWhitespace(el.getAttribute('aria-label') ?? '');
  if (ariaLabel) return ariaLabel;

  const wrapping = wrappingFieldLabel(doc, el);
  if (wrapping) return wrapping;

  const title = collapseWhitespace(el.getAttribute('title') ?? '');
  if (title) return title;

  const placeholder = collapseWhitespace(el.getAttribute('placeholder') ?? '');
  if (placeholder) return placeholder;

  const name = el.getAttribute('name');
  if (name) return name;

  const id = el.getAttribute('id');
  return id && !GENERATED_ID.test(id) ? id : '';
}

/** What counts as a form control when deciding whether a container holds exactly one field. */
const FIELD_CONTROL_SELECTOR =
  'input, textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]';

/**
 * A framework's hidden mirror of a custom widget, rather than a field of its own.
 *
 * react-select renders `<input required tabIndex={-1} aria-hidden="true" style="opacity:0">` beside
 * its combobox purely so native HTML5 validation still fires (this is the `-requiredInput` node
 * Greenhouse ships, see `docs/ats-platform-detection.md` §Greenhouse ¶3); Radix Select renders an
 * equivalent visually-hidden native `<select aria-hidden required>`. Both carry **no `type`**, so
 * `el.type` reads as `'text'` and the native scan takes them for a second, real text field sharing
 * the combobox's wrapper — and therefore its label.
 *
 * Their `required` is still worth reading, which is why {@link hasRequiredProxy} harvests it before
 * {@link detectFields} drops the element.
 */
export function isRequiredProxy(el: Element): boolean {
  return el.getAttribute('aria-hidden') === 'true' && isFormControl(el);
}

/**
 * Ancestors that plausibly wrap `el` *alone*, nearest first.
 *
 * Ascending stops at the first container holding more than one control, since past that point the
 * nearest `<label>` belongs to a neighbouring field rather than to this one. Buttons don't count:
 * a combobox's own dropdown toggle sits beside it inside its wrapper. Neither do the hidden proxies
 * above — a react-select wrapper holds its combobox *and* its `RequiredInput`, which is two controls
 * by a naive count, so the walk used to stop at the widget's own wrapper and find nothing.
 */
export function* fieldWrappers(doc: Document, el: Element): Generator<Element> {
  for (
    let parent = el.parentElement;
    parent && parent !== doc.body;
    parent = parent.parentElement
  ) {
    const controls = Array.from(parent.querySelectorAll(FIELD_CONTROL_SELECTOR));
    if (controls.filter((control) => !isRequiredProxy(control)).length > 1) return;
    yield parent;
  }
}

/**
 * The `<label>` inside the nearest ancestor that wraps this control *alone*.
 *
 * Ashby points a field's `<label for>` at its **field path** (`for="_systemfield_location"`) rather
 * than at the input's id — the input carries no id at all. Every `for`-, wrapper- and ARIA-based
 * lookup therefore misses, and the search used to fall through to the `placeholder`. On Ashby that
 * placeholder is "Start typing…" for every combobox on the form, so a question whose real label
 * read "Where are you currently located?" was classified from, and sent to the answer-drafting
 * model as, "Start typing…" — which is why a location field came back holding a cover letter.
 */
function wrappingFieldLabel(doc: Document, el: Element): string {
  for (const wrapper of fieldWrappers(doc, el)) {
    const label = wrapper.querySelector('label');
    if (!label) continue;

    const text = labelText(label);
    if (text) return text;
  }
  return '';
}
