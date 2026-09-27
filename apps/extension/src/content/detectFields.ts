import type { DetectedField, ElementRole, FieldCategory, FieldOption } from '@djobi/shared';
import {
  associatedLabels,
  collapseWhitespace,
  fieldWrappers,
  getSignal,
  isFormControl,
  isInstanceOf,
  isRequiredProxy,
  labelText,
  NESTED_CONTROL_SELECTOR,
  resolveIdRefs,
  type FieldElement,
} from './pageSignals';
import { choiceLabel, choicesIn, listboxFor, NATIVE_CHOICE_SELECTOR } from './detectedFieldDom';

/** Whether a hidden `required` mirror of a custom widget sits inside this field's own wrapper. */
function hasRequiredProxy(doc: Document, el: Element): boolean {
  for (const wrapper of fieldWrappers(doc, el)) {
    for (const control of wrapper.querySelectorAll(NESTED_CONTROL_SELECTOR)) {
      if (isRequiredProxy(control) && isFormControl(control) && control.required) return true;
    }
  }
  return false;
}

/**
 * Ancestors whose `aria-required` speaks for the field inside (Greenhouse puts it on checkbox-group
 * fieldsets). Limited to field groupings, so a marked page section can't mark every field required.
 */
const REQUIRED_GROUP_SELECTOR = 'fieldset, [role="group"], [role="radiogroup"]';

/** Whether `el`, or a field grouping between it and its form, is marked `aria-required="true"`. */
function ariaRequired(el: Element): boolean {
  if (el.getAttribute('aria-required') === 'true') return true;

  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (
      parent.matches(REQUIRED_GROUP_SELECTOR) &&
      parent.getAttribute('aria-required') === 'true'
    ) {
      return true;
    }
    if (parent.matches('form')) return false;
  }
  return false;
}

/**
 * Required markers in label text: any asterisk variant (Lever uses U+2731) or "(required)". A bare
 * "required" isn't matched ("Not required", "Required experience").
 */
const REQUIRED_MARKER = /[*✱＊∗⁎]|\(\s*required\s*\)/;

/**
 * A required marker at the *end* of a label, stripped from the reported `label` (not from the text
 * {@link getRequired} reads). Otherwise Greenhouse's "First Name*" never matches the API's
 * "First Name" and misses enrichment. End-anchored so a mid-label `*` survives.
 */
const TRAILING_REQUIRED_MARKER = /\s*(?:[*✱＊∗⁎]|\(\s*required\s*\))\s*$/;

/** `signal` without a trailing required marker — see {@link TRAILING_REQUIRED_MARKER}. */
function stripRequiredMarker(signal: string): string {
  return signal.replace(TRAILING_REQUIRED_MARKER, '');
}

/**
 * The two readings of a field's naming text: `label` (reported and matched on; no `*`) and `marked`
 * (where {@link getRequired} looks for a marker). Derived together so neither is read from the
 * wrong text.
 */
interface FieldNaming {
  /** Marker-free: the reported `label`, and what {@link classify} matches on. */
  label: string;
  /** The text a required marker would be written into — {@link getRequired}'s `signal`. */
  marked: string;
}

/**
 * Splits naming text into {@link FieldNaming}. `markerSource` differs only for a file input named
 * by its group, whose marker is still on its own label.
 */
function fieldNaming(naming: string, markerSource: string = naming): FieldNaming {
  return { label: stripRequiredMarker(naming), marked: markerSource };
}

/**
 * Whole class tokens marking a CSS-drawn required asterisk (e.g. MUI's `FormLabel-asterisk`). Not a
 * substring match, which would hit `not-required` or hashed names.
 */
const REQUIRED_CLASS_TOKENS = ['required', 'asterisk'];

/** The label-ish elements whose markup may carry a visual required indicator for `el`. */
function labelScopes(doc: Document, el: Element): Element[] {
  const scopes = [...associatedLabels(doc, el)];

  const legend = el.closest('fieldset')?.querySelector(':scope > legend');
  if (legend) scopes.push(legend);

  // The field's own wrapper, for a marker in a label not formally associated with the control
  // (Lever renders the question as a plain `div` beside the input).
  for (const wrapper of fieldWrappers(doc, el)) scopes.push(wrapper);

  return scopes;
}

/** Whether `el`'s label carries a visual required marker, in its text or as a styled indicator. */
function hasRequiredMarker(doc: Document, el: Element, signal: string): boolean {
  if (REQUIRED_MARKER.test(signal)) return true;

  return labelScopes(doc, el).some((scope) =>
    Array.from(scope.querySelectorAll('*')).some((node) =>
      REQUIRED_CLASS_TOKENS.some((token) => node.classList.contains(token)),
    ),
  );
}

/**
 * Whether a field is required, from a ladder of decreasingly authoritative signals. The first rungs
 * ask the browser: `valueMissing` catches radio groups where only siblings carry `required`
 * (Lever), and `willValidate` lets disabled/readonly elements fall through to weaker signals.
 */
function getRequired(doc: Document, el: Element, signal: string): boolean {
  if (isFormControl(el)) {
    // HTML-AAM §3.6.116: where both `required` and `aria-required` are present, only `required` is
    // exposed — so a native `required` is never vetoed by an `aria-required="false"` beside it.
    if (el.required) return true;
    if (el.willValidate && el.validity.valueMissing) return true;
  }

  return ariaRequired(el) || hasRequiredProxy(doc, el) || hasRequiredMarker(doc, el, signal);
}

/** Assigns stable ids and the selectors that resolve back to them, for one scan of one document. */
interface FieldTagger {
  /**
   * A stable id for `el`, tagging it with `data-djobi-id` if it has none. An existing tag is
   * reused, since answers are keyed by field id across repeated scans.
   */
  id(el: Element): string;
  /**
   * `el`'s id and a selector for it. `CSS.escape`d, since ids like `question_123[]` (Greenhouse)
   * are invalid in a bare `#id`.
   */
  locate(el: Element): { id: string; selector: string };
  /** A {@link FieldOption} for one choice, tagged so the Fill Step can find that exact element. */
  option(el: Element, label: string): FieldOption;
}

/** A tagger for one scan; the id counter lives in this closure. */
function createFieldTagger(doc: Document): FieldTagger {
  let next = 0;

  /**
   * The next id not already tagged onto some element — the counter restarts each scan while earlier
   * tags survive in the DOM, so it can otherwise hand out a duplicate.
   */
  function freshId(): string {
    let id = `djobi-field-${next++}`;
    while (doc.querySelector(`[data-djobi-id="${id}"]`)) id = `djobi-field-${next++}`;
    return id;
  }

  const tagger: FieldTagger = {
    id(el) {
      if (el.id) return el.id;

      const existing = el.getAttribute('data-djobi-id');
      if (existing) return existing;

      const id = freshId();
      el.setAttribute('data-djobi-id', id);
      return id;
    },

    locate(el) {
      const id = tagger.id(el);
      return { id, selector: el.id ? `#${CSS.escape(el.id)}` : `[data-djobi-id="${id}"]` };
    },

    option(el, label) {
      return { label, selector: tagger.locate(el).selector };
    },
  };

  return tagger;
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
  // `located`/`based`: Ashby asks "Where are you currently located?".
  ['location', /location|located|based in|\bcity\b|address/i],
  ['cover_letter_text', /cover letter/i],
  // A bare "Name" (Ashby's single name field). Anchored and last, so "First Name" or "Name of your
  // employer" never match it; the trailing group absorbs a required marker.
  ['full_name', /^\s*name\s*(\*|\(required\))?\s*$/i],
];

const FILE_KEYWORD_RULES: Array<[FieldCategory, RegExp]> = [
  ['cover_letter_upload', /cover letter/i],
  ['resume_upload', /re[sz]ume|\bcv\b/i],
];

/** The accessible name of the nearest ancestor `role="group"`, if it has one. */
function enclosingGroupName(doc: Document, el: Element): string {
  const group = el.closest('[role="group"]');
  if (!group) return '';

  const labelledBy = group.getAttribute('aria-labelledby');
  if (labelledBy) {
    const resolved = resolveIdRefs(doc, labelledBy);
    if (resolved) return resolved;
  }
  return collapseWhitespace(group.getAttribute('aria-label') ?? '');
}

/**
 * A file input's signal, falling back to its enclosing `role="group"` name. Greenhouse labels both
 * file inputs "Attach" and names the group "Resume/CV" or "Cover Letter", which otherwise makes the
 * cover-letter slot a second resume candidate. Only used when the input's own label names no file
 * kind.
 */
function fileFieldSignal(doc: Document, el: Element, signal: string): string {
  if (categoryFor(FILE_KEYWORD_RULES, signal)) return signal;
  return enclosingGroupName(doc, el) || signal;
}

/**
 * A `?`, or an imperative/question-style opener, marks an unmatched free-text field as a
 * free-response question.
 */
const QUESTION_SHAPE = /\?|^(why|how|what|describe|tell us|explain)\b/i;

/**
 * A label opening with an auxiliary verb or condition ("Are…", "Do…", "Have…", "If…") is a
 * screening question, never a profile field — checked before the keyword rules, so "Are you
 * authorized to work in the stated location…?" isn't filled with the candidate's city.
 * "Where…/What…" openers stay profile fields.
 */
const SCREENING_QUESTION_SHAPE =
  /^(are|is|was|were|do|does|did|have|has|had|will|would|can|could|should|may|might|if)\b/i;

/**
 * `if` openers that qualify a field rather than ask anything ("If applicable, LinkedIn URL"), so
 * they aren't demoted to drafted-prose questions.
 */
const CONDITIONAL_QUALIFIER = /^if\s+(applicable|any|none|so|not|known|relevant|available)\b/i;

/**
 * Free-text input types where a question-shaped label means a question. Not `search`: `SCAN_PAGE`
 * scans the whole page, and a site search box's placeholder is often question-shaped.
 */
const FREE_TEXT_INPUT_TYPES = new Set(['textarea', 'text', 'tel', 'url', 'email']);

/** The category `rules` gives `signal`, or `undefined` if none matches. */
function categoryFor(
  rules: Array<[FieldCategory, RegExp]>,
  signal: string,
): FieldCategory | undefined {
  return rules.find(([, pattern]) => pattern.test(signal))?.[0];
}

/**
 * HTML's standard `autocomplete` tokens mapped to categories — the one signal the page states
 * outright, so it outranks keyword rules. Only profile-backed tokens are listed.
 */
const AUTOCOMPLETE_RULES: Record<string, FieldCategory> = {
  'given-name': 'first_name',
  'family-name': 'last_name',
  name: 'full_name',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  url: 'portfolio_url',
  'street-address': 'location',
  'address-line1': 'location',
  'address-level1': 'location',
  'address-level2': 'location',
  'country-name': 'location',
  'postal-code': 'location',
};

/**
 * Tokens that may precede the field name in an `autocomplete` value without changing what it names.
 */
const AUTOCOMPLETE_MODIFIERS = new Set([
  'shipping',
  'billing',
  'home',
  'work',
  'mobile',
  'fax',
  'pager',
]);

/**
 * The category `el`'s `autocomplete` names, parsing the token list (`section-x shipping given-name`
 * → `first_name`). `on`/`off` stop the search.
 */
function autocompleteCategory(el: Element): FieldCategory | undefined {
  const tokens = collapseWhitespace(el.getAttribute('autocomplete') ?? '')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);

  for (const token of tokens) {
    if (token === 'off' || token === 'on') return undefined;
    if (token.startsWith('section-') || AUTOCOMPLETE_MODIFIERS.has(token)) continue;
    return AUTOCOMPLETE_RULES[token];
  }
  return undefined;
}

/**
 * Classifies a field by `autocomplete`, else keyword rules. Otherwise, by `inputType`: file →
 * resume upload, combobox → question, question-shaped free text → question, else `unknown`.
 */
function classify(el: Element, signal: string, inputType: string): FieldCategory {
  if (inputType === 'file') return categoryFor(FILE_KEYWORD_RULES, signal) ?? 'resume_upload';

  const declared = autocompleteCategory(el);
  if (declared) return declared;

  // Before the keyword rules, not after — see {@link SCREENING_QUESTION_SHAPE}.
  if (SCREENING_QUESTION_SHAPE.test(signal) && !CONDITIONAL_QUALIFIER.test(signal)) {
    return 'question';
  }

  const keyword = categoryFor(KEYWORD_RULES, signal);
  if (keyword) return keyword;

  if (inputType === 'combobox') return 'question';
  // All free-text types: Greenhouse renders free-response questions as `<input type="text">`.
  if (FREE_TEXT_INPUT_TYPES.has(inputType) && QUESTION_SHAPE.test(signal)) return 'question';

  return 'unknown';
}

/**
 * Resolves an ARIA-widget's options: `aria-controls`/`aria-owns`'s `role="option"` children, if in
 * the DOM.
 */
function resolveComboboxOptions(
  doc: Document,
  el: Element,
  tagger: FieldTagger,
): FieldOption[] | undefined {
  const listbox = listboxFor(doc, el);
  if (!listbox) return undefined;

  const options = Array.from(listbox.querySelectorAll('[role="option"]'))
    .map((opt) => ({ el: opt, label: collapseWhitespace(opt.textContent ?? '') }))
    .filter((opt) => opt.label !== '')
    .map((opt) => tagger.option(opt.el, opt.label));

  return options.length > 0 ? options : undefined;
}

/**
 * A native `<select>`'s choosable `<option>`s, skipping the empty-valued placeholder ("Select…").
 */
function resolveSelectOptions(el: Element, tagger: FieldTagger): FieldOption[] | undefined {
  if (!isInstanceOf(el, 'HTMLSelectElement')) return undefined;

  const options = Array.from(el.options)
    .filter((opt) => opt.value !== '' && opt.text.trim() !== '')
    .map((opt) => tagger.option(opt, collapseWhitespace(opt.text)));

  return options.length > 0 ? options : undefined;
}

/**
 * Detects `role="combobox"` widgets, which the native query can't see. A combobox not matched by a
 * keyword rule is a `question`. `options` stays undefined when the listbox isn't mounted yet.
 */
function detectComboboxes(doc: Document, tagger: FieldTagger): DetectedField[] {
  return Array.from(doc.querySelectorAll('[role="combobox"]')).map((el) => {
    const { label, marked } = fieldNaming(getSignal(doc, el));
    const { id, selector } = tagger.locate(el);

    return {
      id,
      label,
      inputType: 'combobox',
      selector,
      category: classify(el, label, 'combobox'),
      required: getRequired(doc, el, marked),
      elementRole: 'combobox',
      options: resolveComboboxOptions(doc, el, tagger),
    };
  });
}

/** A signal long enough to be a page section rather than a question label is no signal at all. */
const MAX_SIGNAL_LENGTH = 300;

/**
 * The question a choice group answers: a `<legend>`, an `aria-labelledby` reference, or a preceding
 * sibling label — only siblings holding no controls, so a neighbour's label isn't taken.
 */
function groupSignal(doc: Document, container: Element): string {
  const legend = container.querySelector('legend');
  if (legend) {
    const text = labelText(legend);
    if (text) return text.slice(0, MAX_SIGNAL_LENGTH);
  }

  // `getSignal` already ignores generated ids (`GENERATED_ID`).
  const own = getSignal(doc, container);
  if (own) return own.slice(0, MAX_SIGNAL_LENGTH);

  // The question as a plain element rendered just before the choices — either just outside the
  // container, or as its own first child (the shape a group with no grouping element takes).
  return labelishText([...precedingSiblings(container), ...container.children]) ?? '';
}

/** `el`'s previous siblings, nearest first. */
function* precedingSiblings(el: Element): Generator<Element> {
  for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    yield sibling;
  }
}

/** Elements that hold a control are somebody else's label, not this group's question. */
const CONTROL_SELECTOR =
  'input, textarea, select, button, [role="radio"], [role="checkbox"], [role="combobox"]';

/**
 * The first of `candidates` that reads as a label: has text, and contains no control of its own.
 */
function labelishText(candidates: Element[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate.matches(CONTROL_SELECTOR) || candidate.querySelector(CONTROL_SELECTOR)) continue;
    const text = candidate.textContent?.trim();
    if (text) return text.slice(0, MAX_SIGNAL_LENGTH);
  }
  return undefined;
}

/**
 * Builds one {@link DetectedField} for a container holding `choices`, or `null` if it holds none.
 */
function toGroupField(
  doc: Document,
  container: Element,
  choices: Element[],
  tagger: FieldTagger,
): DetectedField | null {
  if (choices.length === 0) return null;

  const isCheckbox = choices.some(
    (choice) =>
      (isInstanceOf(choice, 'HTMLInputElement') && choice.type === 'checkbox') ||
      choice.getAttribute('role') === 'checkbox',
  );
  const elementRole: ElementRole = isCheckbox ? 'checkboxgroup' : 'radiogroup';
  const { id, selector } = tagger.locate(container);
  const { label, marked } = fieldNaming(groupSignal(doc, container));

  return {
    id,
    label,
    inputType: elementRole,
    selector,
    category: 'question',
    // Required if the container says so *or any choice does* — Lever puts `required` on the radios,
    // not the `<ul>` around them.
    required:
      getRequired(doc, container, marked) ||
      choices.some((choice) => getRequired(doc, choice, choiceLabel(doc, choice))),
    elementRole,
    // Each option keeps its own selector; `choiceLabel` handles `for=`-sibling labels (Ashby) and
    // falls back to the input's `value`.
    options: choices.map((choice) => tagger.option(choice, choiceLabel(doc, choice))),
  };
}

/**
 * Detects choice groups — one field per question — and returns the native inputs consumed so the
 * base scan skips them. Patterns, most explicit first:
 *
 * 1. `<fieldset>` around the inputs.
 * 2. `role="radiogroup"`/`role="group"` — including groups of *buttons* (Ashby), invisible to the
 *    native scan.
 * 3. Radios/checkboxes sharing a `name`, with no grouping element.
 */
function detectChoiceGroups(
  doc: Document,
  tagger: FieldTagger,
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
    const field = toGroupField(doc, container, choices, tagger);
    if (!field) continue;

    for (const choice of choices) {
      claimed.add(choice);
      if (isInstanceOf(choice, 'HTMLInputElement')) grouped.add(choice);
    }
    fields.push(field);
  }

  // Pattern 3: whatever native choices are left, grouped by `name`.
  const byName = new Map<string, HTMLInputElement[]>();
  for (const input of doc.querySelectorAll<HTMLInputElement>(NATIVE_CHOICE_SELECTOR)) {
    if (claimed.has(input) || !input.name) continue;
    const group = byName.get(input.name);
    if (group) group.push(input);
    else byName.set(input.name, [input]);
  }

  for (const inputs of byName.values()) {
    // A lone named checkbox is a consent toggle ("I agree to…"), not a question with choices.
    if (inputs.length < 2) continue;

    const container = commonAncestor(inputs);
    if (!container) continue;

    const field = toGroupField(doc, container, inputs, tagger);
    if (!field) continue;

    for (const input of inputs) grouped.add(input);
    fields.push(field);
  }

  return { fields, grouped };
}

/** The nearest element containing all of `elements` — the group's implicit container. */
function commonAncestor(elements: Element[]): Element | null {
  for (
    let ancestor = elements[0]?.parentElement ?? null;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const candidate = ancestor;
    if (elements.every((el) => candidate.contains(el))) return candidate;
  }
  return null;
}

/** Input types that carry no candidate-supplied data, so they're never a {@link DetectedField}. */
const NON_DATA_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/**
 * Finds every candidate-fillable field and classifies it into a {@link DetectedField}. Three
 * passes, each narrowing the next: choice groups, native controls, then `role="combobox"` widgets.
 *
 * Contract beyond the signature:
 *
 * - **Writes to the document**: untagged fields/options get `data-djobi-id`. So never call it from
 *   an attribute `MutationObserver` on the same document (`detect.ts` filters for this).
 * - **Return order is `[native…, comboboxes…, groups…]`**, not document order.
 * - **Ids are stable across scans** while the element lives; a page-supplied `id` wins, and
 *   remounted React widgets regenerate theirs (`matchAnswerToField` falls back to labels).
 * - **`options: undefined`** means choices unknown (listbox mounts on open); `[]` means none.
 * - **`required` depends partly on `label`**; `label` may be `''`.
 * - Superlinear cost — run on a settled DOM, not per keystroke.
 * - Realm-safe: an `iframe.contentDocument` works (see {@link isInstanceOf}).
 */
export function detectFields(doc: Document): DetectedField[] {
  const tagger = createFieldTagger(doc);
  const { fields: groupFields, grouped } = detectChoiceGroups(doc, tagger);

  const nativeFields = Array.from(doc.querySelectorAll<FieldElement>('input, textarea, select'))
    .filter(
      (el) =>
        !NON_DATA_INPUT_TYPES.has(el.type) &&
        !grouped.has(el) &&
        el.getAttribute('role') !== 'combobox' &&
        // A framework's hidden validation mirror isn't a field; `hasRequiredProxy` already took its
        // `required` for the real widget.
        !isRequiredProxy(el),
    )
    .map((el): DetectedField => {
      const inputType = el.type;
      const signal = getSignal(doc, el);
      // A file input may be named by its group (see {@link fileFieldSignal}) while the required
      // marker stays on its own label.
      const { label, marked } = fieldNaming(
        inputType === 'file' ? fileFieldSignal(doc, el, signal) : signal,
        signal,
      );
      const { id, selector } = tagger.locate(el);

      return {
        id,
        label,
        inputType,
        selector,
        category: classify(el, label, inputType),
        required: getRequired(doc, el, marked),
        elementRole: 'native',
        options: resolveSelectOptions(el, tagger),
      };
    });

  return [...nativeFields, ...detectComboboxes(doc, tagger), ...groupFields];
}
