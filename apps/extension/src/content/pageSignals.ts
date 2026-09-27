/**
 * How the extension reads an ATS page — DOM class checks and the text naming an element — shared by
 * detection (`detectFields.ts`) and filling (`detectedFieldDom.ts`). Everything is **realm-safe**
 * via {@link isInstanceOf}, so `iframe.contentDocument` reads like the main document.
 */

/** Field elements that carry data a candidate fills in, as opposed to buttons/hidden inputs. */
export type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * `el instanceof <name>` in `el`'s own realm (via `ownerDocument.defaultView`). A bare `instanceof`
 * fails silently for elements from another document, e.g. an iframe's.
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
 * Collapses whitespace to one line (like the accessible-name "flat string"), since multi-line label
 * markup would defeat keyword rules and API label matching.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Controls whose own text must not be read as part of a label that wraps them. */
export const NESTED_CONTROL_SELECTOR = 'input, textarea, select, button';

/**
 * A label's text excluding controls nested inside it (HTML-AAM), so Lever's wrapped `<select>`
 * doesn't add "United States" to "Country".
 */
export function labelText(label: Element): string {
  if (!label.querySelector(NESTED_CONTROL_SELECTOR))
    return collapseWhitespace(label.textContent ?? '');

  const copy = label.cloneNode(true) as Element;
  for (const control of copy.querySelectorAll(NESTED_CONTROL_SELECTOR)) control.remove();
  return collapseWhitespace(copy.textContent ?? '');
}

/**
 * Every `<label for>` pointing at `id` — all of them, since the accessible name concatenates every
 * associated label.
 */
function labelsForId(doc: Document, id: string): Element[] {
  return Array.from(doc.querySelectorAll('label[for]')).filter(
    (label) => label.getAttribute('for') === id,
  );
}

/**
 * The labels formally associated with `el`: `HTMLElement.labels` for real controls; a manual lookup
 * for ARIA widgets, which have no `.labels`.
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
 * Generated ids (`react-select-3-input`, React's `:r1:`) — never used as a label, since `getSignal`
 * falls back to `id` last.
 */
const GENERATED_ID =
  /^:r[0-9a-z]*:$|(^|[-_])(react|radix|headlessui|mui|downshift|select)([-_]|$)/i;

/**
 * The text that names a field: associated `<label>`, `aria-labelledby`, `aria-label`, its wrapper's
 * label ({@link wrappingFieldLabel}), then `title`, `placeholder` and attribute fallbacks (HTML-AAM
 * order, plus the wrapper step).
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
 * A framework's hidden validation mirror of a custom widget — react-select's typeless
 * `<input required aria-hidden>` or Radix's hidden `<select>` — not a field of its own. Its
 * `required` is still harvested by {@link hasRequiredProxy} before {@link detectFields} drops it.
 */
export function isRequiredProxy(el: Element): boolean {
  return el.getAttribute('aria-hidden') === 'true' && isFormControl(el);
}

/**
 * Ancestors wrapping `el` alone, nearest first. Stops at a container with a second control (buttons
 * and hidden proxies don't count), past which the nearest label belongs to a neighbour.
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
 * The `<label>` inside the nearest wrapper holding only this control. Needed for Ashby, whose
 * `<label for>` points at a field path rather than the input (which has no id) — otherwise the
 * signal falls through to the placeholder, "Start typing…".
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
