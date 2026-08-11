import type { DetectedField, ElementRole, FieldCategory } from '@djobi/shared';

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

  return (
    el.getAttribute('aria-label') ??
    el.getAttribute('placeholder') ??
    el.getAttribute('name') ??
    id ??
    ''
  );
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

/** Assigns/reuses a stable id for an element, tagging it with `data-djobi-id` if it has none of its own. */
function assignId(el: Element, counter: { n: number }): string {
  if (el.id) return el.id;
  const id = `djobi-field-${counter.n++}`;
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
  ['location', /location|city|address/i],
  ['cover_letter_text', /cover letter/i],
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

/** Resolves an ARIA-widget's option text: `aria-controls`/`aria-owns`'s `role="option"` children, if in the DOM. */
function resolveComboboxOptions(doc: Document, el: Element): string[] | undefined {
  const controlsId = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
  if (!controlsId) return undefined;

  const listbox = doc.getElementById(controlsId);
  if (!listbox) return undefined;

  const options = Array.from(listbox.querySelectorAll('[role="option"]'))
    .map((opt) => opt.textContent?.trim() ?? '')
    .filter(Boolean);

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
    const id = assignId(el, counter);
    const match = KEYWORD_RULES.find(([, pattern]) => pattern.test(signal));

    return {
      id,
      label: signal,
      inputType: 'combobox',
      selector: selectorFor(el, id),
      category: match?.[0] ?? 'question',
      required: getRequired(doc, el),
      elementRole: 'combobox' as ElementRole,
      options: resolveComboboxOptions(doc, el),
    };
  });
}

/**
 * Detects `<fieldset>`-wrapped radio/checkbox groups, producing one {@link DetectedField} per
 * group (not one per input) with each option's label text collected into `options`. Returns the
 * grouped `<input>` elements too, so the base native-element scan can exclude them and avoid
 * double-reporting.
 */
function detectFieldsetGroups(
  doc: Document,
  counter: { n: number },
): { fields: DetectedField[]; grouped: Set<Element> } {
  const fieldsets = Array.from(doc.querySelectorAll('fieldset')).filter((fieldset) =>
    fieldset.querySelector('input[type="checkbox"], input[type="radio"]'),
  );

  const grouped = new Set<Element>();
  const fields: DetectedField[] = [];

  for (const fieldset of fieldsets) {
    const inputs = Array.from(
      fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]'),
    );
    inputs.forEach((input) => grouped.add(input));

    const legend = fieldset.querySelector('legend');
    const signal = legend?.textContent?.trim() ?? getSignal(doc, fieldset);
    // `closest('label')` alone misses ATS markup where each option's label is a `for=id` sibling
    // rather than a wrapper (e.g. Ashby's radio groups) — `getSignal` already covers that lookup,
    // falling back to the input's own `value` only when no label can be found at all.
    const options = inputs.map((input) => {
      const optionSignal = getSignal(doc, input);
      return optionSignal || input.value;
    });
    const elementRole: ElementRole = inputs[0]?.type === 'radio' ? 'radiogroup' : 'checkboxgroup';
    const id = assignId(fieldset, counter);

    fields.push({
      id,
      label: signal,
      inputType: elementRole,
      selector: selectorFor(fieldset, id),
      category: 'question',
      required: getRequired(doc, fieldset),
      elementRole,
      options,
    });
  }

  return { fields, grouped };
}

/**
 * Finds every candidate-fillable field on the page and classifies it into a {@link DetectedField},
 * using each field's `<label for>` text (or aria-label/placeholder/name/id fallback) as the
 * classification signal. See `docs/architecture-plan.md`'s "Generic field detection" section.
 */
const NON_DATA_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

export function detectFields(doc: Document): DetectedField[] {
  const counter = { n: 0 };
  const { fields: groupFields, grouped } = detectFieldsetGroups(doc, counter);

  const elements = Array.from(doc.querySelectorAll('input, textarea, select')) as FieldElement[];
  const dataElements = elements.filter(
    (el) =>
      !NON_DATA_INPUT_TYPES.has((el as HTMLInputElement).type) &&
      !grouped.has(el) &&
      el.getAttribute('role') !== 'combobox',
  );

  const nativeFields: DetectedField[] = dataElements.map((el) => {
    const signal = getSignal(doc, el);
    const id = assignId(el, counter);
    const inputType = (el as HTMLInputElement).type ?? el.tagName.toLowerCase();

    return {
      id,
      label: signal,
      inputType,
      selector: selectorFor(el, id),
      category: classify(signal, inputType),
      required: getRequired(doc, el),
      elementRole: 'native' as ElementRole,
    };
  });

  const comboboxFields = detectComboboxes(doc, counter);

  return [...nativeFields, ...comboboxFields, ...groupFields];
}
