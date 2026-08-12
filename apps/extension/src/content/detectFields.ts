import type { DetectedField, ElementRole, FieldCategory, FieldOption } from '@djobi/shared';

/** Field elements that carry data a candidate fills in, as opposed to buttons/hidden inputs. */
type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Concatenated `textContent` of every element referenced by a whitespace-separated id list. */
function resolveIdRefs(doc: Document, idRefs: string): string {
  return idRefs
    .split(/\s+/)
    .map((refId) => doc.getElementById(refId)?.textContent?.trim())
    .filter((text): text is string => !!text)
    .join(' ');
}

/**
 * Signal text used to classify a field: its `<label for>` text, a wrapping `<label>` with no
 * `for`, an `aria-labelledby` reference, or attribute fallbacks, in that order.
 */
export function getSignal(doc: Document, el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }

  const wrappingLabel = el.closest('label');
  if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const resolved = resolveIdRefs(doc, labelledBy);
    if (resolved) return resolved;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  const wrapping = wrappingFieldLabel(doc, el);
  if (wrapping) return wrapping;

  return el.getAttribute('placeholder') ?? el.getAttribute('name') ?? id ?? '';
}

/** What counts as a form control when deciding whether a container holds exactly one field. */
const FIELD_CONTROL_SELECTOR =
  'input, textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]';

/**
 * The `<label>` inside the nearest ancestor that wraps this control *alone*.
 *
 * Ashby points a field's `<label for>` at its **field path** (`for="_systemfield_location"`) rather
 * than at the input's id — the input carries no id at all. Every `for`-, wrapper- and ARIA-based
 * lookup therefore misses, and the search used to fall through to the `placeholder`. On Ashby that
 * placeholder is "Start typing…" for every combobox on the form, so a question whose real label
 * read "Where are you currently located?" was classified from, and sent to the answer-drafting
 * model as, "Start typing…" — which is why a location field came back holding a cover letter.
 *
 * Ascending stops at the first container holding more than one control, since past that point the
 * nearest `<label>` belongs to a neighbouring field rather than to this one. Buttons don't count:
 * a combobox's own dropdown toggle sits beside it inside its wrapper.
 */
function wrappingFieldLabel(doc: Document, el: Element): string {
  for (
    let parent = el.parentElement;
    parent && parent !== doc.body;
    parent = parent.parentElement
  ) {
    if (parent.querySelectorAll(FIELD_CONTROL_SELECTOR).length > 1) return '';

    const text = parent.querySelector('label')?.textContent?.trim();
    if (text) return text;
  }
  return '';
}

/** Nearest ancestor `<label>` or `<legend>` for a field, used to look for a visual required marker. */
function nearestLabelOrLegend(doc: Document, el: Element): Element | null {
  const id = el.getAttribute('id');
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label) return label;
  }
  return el.closest('label, fieldset')?.querySelector('label, legend') ?? el.closest('label');
}

/** Whether a field is marked required, via the native attribute, `aria-required`, or a visual marker. */
function getRequired(doc: Document, el: Element): boolean {
  return (
    (el as HTMLInputElement).required === true ||
    el.getAttribute('aria-required') === 'true' ||
    el.closest('[aria-required="true"]') != null ||
    nearestLabelOrLegend(doc, el)?.querySelector('.required, [class*="required"]') != null
  );
}

/**
 * Assigns/reuses a stable id for an element, tagging it with `data-djobi-id` if it has none of its
 * own.
 *
 * A tag already on the element is reused rather than reissued, so an element keeps the same id
 * across repeated scans of the same page. The page is now re-scanned as it changes (see
 * `detect.ts`) and again at fill time, and drafted answers are keyed by field id: reissuing ids
 * from a counter that restarts at zero each scan would silently re-point every answer at whichever
 * field now happens to occupy that position in document order.
 *
 * New ids skip any value already tagged onto another element, since the counter — restarting at
 * zero while earlier tags survive in the DOM — would otherwise hand out a duplicate.
 */
function assignId(doc: Document, el: Element, counter: { n: number }): string {
  if (el.id) return el.id;

  const existing = el.getAttribute('data-djobi-id');
  if (existing) return existing;

  let id = `djobi-field-${counter.n++}`;
  while (doc.querySelector(`[data-djobi-id="${id}"]`)) id = `djobi-field-${counter.n++}`;

  el.setAttribute('data-djobi-id', id);
  return id;
}

/**
 * CSS selector that resolves back to `el`, given the id `assignId` produced for it. `el.id` is
 * escaped via `CSS.escape` — some ATS platforms (e.g. Greenhouse's multi-value fields) use ids
 * like `question_123[]`, which are invalid unescaped in a `#id` selector.
 */
function selectorFor(el: Element, id: string): string {
  return el.id ? `#${CSS.escape(el.id)}` : `[data-djobi-id="${id}"]`;
}

const KEYWORD_RULES: Array<[FieldCategory, RegExp]> = [
  ['email', /e-?mail/i],
  ['linkedin_url', /linkedin/i],
  ['github_url', /git ?hub/i],
  ['portfolio_url', /portfolio|website/i],
  ['first_name', /first name|given name/i],
  ['last_name', /last name|surname|family name/i],
  ['full_name', /full name|legal name/i],
  ['phone', /phone|mobile/i],
  // `located`/`based` as well as `location`: Ashby asks "Where are you currently located?", which
  // the bare `location` stem doesn't match, so it fell through to `question` and was handed to the
  // answer-drafting model instead of being filled from the profile.
  ['location', /location|located|based in|\bcity\b|address/i],
  ['cover_letter_text', /cover letter/i],
  // A bare "Name" — Ashby labels its single required name field exactly that, and without this it
  // classified as `unknown` and was never filled. Anchored, and deliberately last, so it only
  // catches a signal that is *nothing but* the word: "First Name", "Name of your employer" and
  // "Preferred name" all match an earlier rule or none at all rather than being mistaken for the
  // candidate's own full name.
  // The trailing group absorbs a required marker rendered inside the label text ("Name *",
  // "Name (required)"), which `getSignal` returns verbatim as part of the label's `textContent`.
  ['full_name', /^\s*name\s*(\*|\(required\))?\s*$/i],
];

const FILE_KEYWORD_RULES: Array<[FieldCategory, RegExp]> = [
  ['cover_letter_upload', /cover letter/i],
  ['resume_upload', /re[sz]ume|\bcv\b/i],
];

/** A `?`, or an imperative/question-style opener, marks an unmatched textarea as a free-response question. */
const QUESTION_SHAPE = /\?|^(why|how|what|describe|tell us|explain)\b/i;

/** Classifies a field by keyword-matching its signal text against a fixed category list. */
function classify(signal: string, inputType: string): FieldCategory {
  if (inputType === 'file') {
    const match = FILE_KEYWORD_RULES.find(([, pattern]) => pattern.test(signal));
    return match?.[0] ?? 'resume_upload';
  }

  const match = KEYWORD_RULES.find(([, pattern]) => pattern.test(signal));
  if (match) return match[0];

  if (inputType === 'textarea' && QUESTION_SHAPE.test(signal)) return 'question';

  return 'unknown';
}

/**
 * Builds a {@link FieldOption} for one choice, tagging its element so the Fill Step can find that
 * exact element again instead of re-deriving its label from the DOM and hoping both derivations
 * agree.
 */
function toOption(doc: Document, el: Element, label: string, counter: { n: number }): FieldOption {
  const id = assignId(doc, el, counter);
  return { label, selector: selectorFor(el, id) };
}

/** Resolves an ARIA-widget's options: `aria-controls`/`aria-owns`'s `role="option"` children, if in the DOM. */
function resolveComboboxOptions(
  doc: Document,
  el: Element,
  counter: { n: number },
): FieldOption[] | undefined {
  const controlsId = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
  if (!controlsId) return undefined;

  const listbox = doc.getElementById(controlsId);
  if (!listbox) return undefined;

  const options = Array.from(listbox.querySelectorAll('[role="option"]'))
    .map((opt) => ({ el: opt, label: opt.textContent?.trim() ?? '' }))
    .filter((opt) => opt.label)
    .map((opt) => toOption(doc, opt.el, opt.label, counter));

  return options.length > 0 ? options : undefined;
}

/**
 * A native `<select>`'s selectable `<option>` elements. Selects previously reported no choices at
 * all, so a select-backed question was drafted with nothing to choose from and could only be filled
 * by matching option text at fill time — the exact fragility this module avoids everywhere else.
 * The empty-valued leading placeholder ("Select…") is skipped: it isn't an answer.
 */
function resolveSelectOptions(
  doc: Document,
  el: Element,
  counter: { n: number },
): FieldOption[] | undefined {
  if (!(el instanceof HTMLSelectElement)) return undefined;

  const options = Array.from(el.options)
    .filter((opt) => opt.value !== '' && opt.text.trim())
    .map((opt) => toOption(doc, opt, opt.text.trim(), counter));

  return options.length > 0 ? options : undefined;
}

/**
 * Detects `role="combobox"` widgets (react-select-style custom dropdowns) — invisible to the
 * native `input, textarea, select` query. Always promoted to `'question'` when unmatched by a
 * keyword rule; a combobox is inherently a choice prompt, so (unlike free-text fields) it needs
 * no `QUESTION_SHAPE` gate. `options` is left undefined when the widget's option list isn't in
 * the DOM yet (e.g. portal-mounted only once opened) rather than dropping the field.
 */
function detectComboboxes(doc: Document, counter: { n: number }): DetectedField[] {
  const comboboxes = Array.from(doc.querySelectorAll('[role="combobox"]'));

  return comboboxes.map((el) => {
    const signal = getSignal(doc, el);
    const id = assignId(doc, el, counter);
    const match = KEYWORD_RULES.find(([, pattern]) => pattern.test(signal));

    return {
      id,
      label: signal,
      inputType: 'combobox',
      selector: selectorFor(el, id),
      category: match?.[0] ?? 'question',
      required: getRequired(doc, el),
      elementRole: 'combobox' as ElementRole,
      options: resolveComboboxOptions(doc, el, counter),
    };
  });
}

/** Native choice inputs — one question's mutually-exclusive (radio) or multi-select (checkbox) answers. */
const NATIVE_CHOICE_SELECTOR = 'input[type="radio"], input[type="checkbox"]';

/**
 * Choices built out of ARIA rather than inputs — a `<button role="radio">`, a `<div role="checkbox">`,
 * or a pressed-state toggle button. Only ever looked for *inside* a container already identified as
 * a choice group, so ordinary page buttons (submit, nav, "add another") can't be mistaken for answers.
 */
const ARIA_CHOICE_SELECTOR = '[role="radio"], [role="checkbox"], button[aria-pressed]';

/** The choices in a group: its native inputs, or its ARIA stand-ins when it has no native ones. */
function choicesIn(container: Element): Element[] {
  const native = Array.from(container.querySelectorAll(NATIVE_CHOICE_SELECTOR));
  if (native.length > 0) return native;
  return Array.from(container.querySelectorAll(ARIA_CHOICE_SELECTOR));
}

/**
 * One choice's visible answer text.
 *
 * Exported because `fillForm.ts` has to recover the element for a drafted answer from this exact
 * text when the choice carries no recorded selector — deriving it a second way there is how the two
 * halves come to disagree.
 */
export function choiceLabel(doc: Document, el: Element): string {
  if (el instanceof HTMLInputElement) return getSignal(doc, el) || el.value;
  return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '';
}

/** A signal long enough to be a page section rather than a question label is no signal at all. */
const MAX_SIGNAL_LENGTH = 300;

/**
 * The question a group of choices answers.
 *
 * Unlike a single input, a group rarely carries its own label: the question is a `<legend>`, an
 * `aria-labelledby` reference, or just a `<label>`/`<div>` rendered immediately above the choices.
 * The last of those is why this falls back to preceding siblings — but only ones holding no form
 * controls of their own, so it can't pick up a neighbouring field's label instead.
 */
function groupSignal(doc: Document, container: Element): string {
  const legend = container.querySelector('legend');
  if (legend?.textContent?.trim()) return legend.textContent.trim();

  const own = getSignal(doc, container);
  if (own && own !== container.id) return own.slice(0, MAX_SIGNAL_LENGTH);

  // The question as a plain element rendered just before the choices — either just outside the
  // container, or as its own first child (the shape a group with no grouping element takes).
  const siblings: Element[] = [];
  for (
    let sibling = container.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    siblings.push(sibling);
  }

  return labelishText([...siblings, ...container.children]) ?? '';
}

/** Elements that hold a control are somebody else's label, not this group's question. */
const CONTROL_SELECTOR =
  'input, textarea, select, button, [role="radio"], [role="checkbox"], [role="combobox"]';

/** The first of `candidates` that reads as a label: has text, and contains no control of its own. */
function labelishText(candidates: Element[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate.matches(CONTROL_SELECTOR) || candidate.querySelector(CONTROL_SELECTOR)) continue;
    const text = candidate.textContent?.trim();
    if (text) return text.slice(0, MAX_SIGNAL_LENGTH);
  }
  return undefined;
}

/** Builds one {@link DetectedField} for a container holding `choices`, or `null` if it holds none. */
function toGroupField(
  doc: Document,
  container: Element,
  choices: Element[],
  counter: { n: number },
): DetectedField | null {
  if (choices.length === 0) return null;

  const isCheckbox = choices.some(
    (choice) =>
      (choice instanceof HTMLInputElement && choice.type === 'checkbox') ||
      choice.getAttribute('role') === 'checkbox',
  );
  const elementRole: ElementRole = isCheckbox ? 'checkboxgroup' : 'radiogroup';
  const id = assignId(doc, container, counter);

  return {
    id,
    label: groupSignal(doc, container),
    inputType: elementRole,
    selector: selectorFor(container, id),
    category: 'question',
    required: getRequired(doc, container),
    elementRole,
    // Each option keeps a selector to its own element, so the Fill Step never has to repeat this
    // derivation. `choiceLabel` covers ATS markup where an option's label is a `for=id` sibling
    // rather than a wrapper (e.g. Ashby's radio groups), falling back to the input's own `value`
    // only when no label can be found at all.
    options: choices.map((choice) => toOption(doc, choice, choiceLabel(doc, choice), counter)),
  };
}

/**
 * Detects choice groups — one {@link DetectedField} per question, not one per option — and returns
 * the native inputs it consumed so the base scan can skip them.
 *
 * Three markup patterns, in descending order of how explicit they are:
 *
 * 1. `<fieldset>` around the inputs, the HTML-native grouping.
 * 2. `role="radiogroup"`/`role="group"`, the ARIA equivalent. This is how the choices reach the
 *    page as *buttons* rather than inputs (Ashby renders "Are you willing to work onsite?" this
 *    way) — a shape the native `input, textarea, select` scan cannot see at all, so the question
 *    was previously never detected, never answered, and silently left blank.
 * 3. Radios/checkboxes sharing a `name`. Inputs with the same name *are* one question by
 *    definition, so this catches groups with no grouping element at all — which used to arrive as
 *    one `unknown` field per option, each labelled "Yes"/"No" rather than with the question, and
 *    each therefore unfillable.
 */
function detectChoiceGroups(
  doc: Document,
  counter: { n: number },
): { fields: DetectedField[]; grouped: Set<Element> } {
  const grouped = new Set<Element>();
  const fields: DetectedField[] = [];
  const claimed = new Set<Element>();

  const containers = Array.from(
    doc.querySelectorAll('fieldset, [role="radiogroup"], [role="group"]'),
  );

  for (const container of containers) {
    // A nested group (a `role="radiogroup"` inside a `<fieldset>`) belongs to whichever container
    // claimed its choices first — the outer one — rather than being reported twice.
    const choices = choicesIn(container).filter((choice) => !claimed.has(choice));
    const field = toGroupField(doc, container, choices, counter);
    if (!field) continue;

    for (const choice of choices) {
      claimed.add(choice);
      if (choice instanceof HTMLInputElement) grouped.add(choice);
    }
    fields.push(field);
  }

  // Pattern 3: whatever native choices are left, grouped by `name`.
  const byName = new Map<string, HTMLInputElement[]>();
  for (const input of doc.querySelectorAll<HTMLInputElement>(NATIVE_CHOICE_SELECTOR)) {
    if (claimed.has(input) || !input.name) continue;
    byName.set(input.name, [...(byName.get(input.name) ?? []), input]);
  }

  for (const inputs of byName.values()) {
    // A lone named checkbox is a consent toggle ("I agree to…"), not a question with choices.
    if (inputs.length < 2) continue;

    const container = commonAncestor(inputs);
    if (!container) continue;

    const field = toGroupField(doc, container, inputs, counter);
    if (!field) continue;

    inputs.forEach((input) => grouped.add(input));
    fields.push(field);
  }

  return { fields, grouped };
}

/** The nearest element containing all of `elements` — the group's implicit container. */
function commonAncestor(elements: Element[]): Element | null {
  let ancestor: Element | null = elements[0]?.parentElement ?? null;
  while (ancestor && !elements.every((el) => ancestor?.contains(el))) {
    ancestor = ancestor.parentElement;
  }
  return ancestor;
}

/**
 * Finds every candidate-fillable field on the page and classifies it into a {@link DetectedField},
 * using each field's `<label for>` text (or aria-label/placeholder/name/id fallback) as the
 * classification signal. See `docs/architecture-plan.md`'s "Generic field detection" section.
 */
const NON_DATA_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

export function detectFields(doc: Document): DetectedField[] {
  const counter = { n: 0 };
  const { fields: groupFields, grouped } = detectChoiceGroups(doc, counter);

  const elements = Array.from(doc.querySelectorAll('input, textarea, select')) as FieldElement[];
  const dataElements = elements.filter(
    (el) =>
      !NON_DATA_INPUT_TYPES.has((el as HTMLInputElement).type) &&
      !grouped.has(el) &&
      el.getAttribute('role') !== 'combobox',
  );

  const nativeFields: DetectedField[] = dataElements.map((el) => {
    const signal = getSignal(doc, el);
    const id = assignId(doc, el, counter);
    const inputType = (el as HTMLInputElement).type ?? el.tagName.toLowerCase();

    return {
      id,
      label: signal,
      inputType,
      selector: selectorFor(el, id),
      category: classify(signal, inputType),
      required: getRequired(doc, el),
      elementRole: 'native' as ElementRole,
      options: resolveSelectOptions(doc, el, counter),
    };
  });

  const comboboxFields = detectComboboxes(doc, counter);

  return [...nativeFields, ...comboboxFields, ...groupFields];
}
