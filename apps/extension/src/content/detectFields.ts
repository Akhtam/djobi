import type { DetectedField, ElementRole, FieldCategory, FieldOption } from '@djobi/shared';

/** Field elements that carry data a candidate fills in, as opposed to buttons/hidden inputs. */
type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

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
function isInstanceOf<K extends 'HTMLInputElement' | 'HTMLTextAreaElement' | 'HTMLSelectElement'>(
  el: Element,
  className: K,
): el is InstanceType<(Window & typeof globalThis)[K]> {
  const view = el.ownerDocument.defaultView;
  return view ? el instanceof view[className] : false;
}

/** Whether `el` is one of the three elements carrying `required`, `labels` and a validity state. */
function isFormControl(el: Element): el is FieldElement {
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
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Controls whose own text must not be read as part of a label that wraps them. */
const NESTED_CONTROL_SELECTOR = 'input, textarea, select, button';

/**
 * A label's text, with any control it wraps excluded.
 *
 * HTML-AAM's naming step for form controls says to exclude the control's own value from the label
 * it is nested inside. That matters for the wrap-style association Lever uses: a `<select>` nested
 * in its own `<label>` contributes its selected option's text to the label's `textContent`, so a
 * pre-filled field's label reads "Country United States" and stops matching anything.
 */
function labelText(label: Element): string {
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
function associatedLabels(doc: Document, el: Element): Element[] {
  if (isFormControl(el)) return Array.from(el.labels ?? []);

  const id = el.getAttribute('id');
  const explicit = id ? labelsForId(doc, id) : [];
  if (explicit.length > 0) return explicit;

  const wrapping = el.closest('label');
  return wrapping ? [wrapping] : [];
}

/** Concatenated `textContent` of every element referenced by a whitespace-separated id list. */
function resolveIdRefs(doc: Document, idRefs: string): string {
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
function isRequiredProxy(el: Element): boolean {
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
function* fieldWrappers(doc: Document, el: Element): Generator<Element> {
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
 * Ancestors allowed to carry an `aria-required` that speaks for the field inside them.
 *
 * ARIA puts `aria-required` on the widget itself; no ancestor role supports it. Greenhouse
 * nonetheless ships `<fieldset aria-required="true">` around its checkbox groups
 * (`docs/ats-platform-detection.md` §Greenhouse ¶3), which is worth honouring — but only from a
 * *field grouping*. The check used to be `el.closest('[aria-required="true"]')`, which accepted the
 * attribute from any ancestor whatsoever, so one marked page section silently marked every field
 * beneath it as required.
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
 * Required markers rendered into the label text: a bare asterisk in any of the forms ATS platforms
 * use (Lever emits U+2731 specifically), or a parenthesised word.
 *
 * A bare "required" is deliberately not matched — it reads the wrong way round in "Not required"
 * and "Required experience", which are ordinary label text.
 */
const REQUIRED_MARKER = /[*✱＊∗⁎]|\(\s*required\s*\)/;

/**
 * A required marker sitting at the *end* of a label, where ATS platforms render it.
 *
 * Stripped from the reported `label` (never from the text {@link getRequired} reads, which is what
 * the marker is *for*). Greenhouse renders `<label>First Name<span class="required">*</span></label>`,
 * so the label reached the rest of the pipeline as `"First Name*"` — and `normalizeLabel` only
 * trims and lowercases, so it matched the Greenhouse API's `"First Name"` nowhere. Every required
 * question on a Greenhouse posting therefore missed API enrichment, which is precisely the set of
 * fields enrichment exists to serve: the required comboboxes whose choices are not in the DOM.
 *
 * Anchored at the end so an asterisk inside real label text ("Rate 1-5 (5 = best*)") survives.
 */
const TRAILING_REQUIRED_MARKER = /\s*(?:[*✱＊∗⁎]|\(\s*required\s*\))\s*$/;

/** `signal` without a trailing required marker — see {@link TRAILING_REQUIRED_MARKER}. */
function stripRequiredMarker(signal: string): string {
  return signal.replace(TRAILING_REQUIRED_MARKER, '');
}

/**
 * The two readings every {@link DetectedField} needs of the text that names it.
 *
 * They differ by the required marker, and both are load-bearing: `label` is what the pipeline
 * reports, classifies and label-matches on, and must not carry a `*`; `marked` is where a marker
 * would be written, and is the `signal` {@link getRequired} reads. Derived as a pair, at one place,
 * because deriving either alone is precisely how this goes wrong — twice already, once by reading
 * the marker off text it had just been stripped from, and once by reading it off a group's name
 * instead of the input's own label.
 */
interface FieldNaming {
  /** Marker-free: the reported `label`, and what {@link classify} matches on. */
  label: string;
  /** The text a required marker would be written into — {@link getRequired}'s `signal`. */
  marked: string;
}

/**
 * Splits naming text into the pair above. `markerSource` defaults to `naming` and is passed
 * separately only where the two genuinely differ — a file input named by the group around it, whose
 * marker still belongs to its own label.
 */
function fieldNaming(naming: string, markerSource: string = naming): FieldNaming {
  return { label: stripRequiredMarker(naming), marked: markerSource };
}

/**
 * Class tokens that mark a required indicator whose asterisk is drawn by CSS `content` rather than
 * written into the markup (MUI's `FormLabel-asterisk` slot works this way).
 *
 * Matched as whole `classList` tokens. The previous `[class*="required"]` substring match also hit
 * `not-required`, `required-hint` and emotion-hashed names like `css-1x2y3z-requiredInput`, marking
 * plainly optional fields as required.
 */
const REQUIRED_CLASS_TOKENS = ['required', 'asterisk'];

/** The label-ish elements whose markup may carry a visual required indicator for `el`. */
function labelScopes(doc: Document, el: Element): Element[] {
  const scopes = [...associatedLabels(doc, el)];

  const legend = el.closest('fieldset')?.querySelector(':scope > legend');
  if (legend) scopes.push(legend);

  // The field's own wrapper, for a marker in a label that is *not* formally associated with the
  // control. Lever renders the question as a plain `<div class="application-label">` beside the
  // input, with the asterisk inside it — associated-labels-plus-legend alone sees none of that, so
  // narrowing to those two dropped the marker for every Lever field whose label isn't `for`-bound.
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
 * Whether a field is marked required, as an ordered ladder of decreasingly authoritative signals.
 *
 * The first two rungs are the browser's own answer rather than an attribute guess. `valueMissing`
 * matters most for radio groups: the HTML spec makes a radio "suffering from being missing" when
 * *any* member of its group is `required` and none is checked, so an unmarked radio whose sibling
 * carries the attribute still reports it — which is exactly Lever's markup, where `required` sits on
 * the `<input>`s and nothing on the `<ul>` around them. `willValidate` guards the rung so that
 * `disabled`, `readonly` and otherwise barred elements fall through to the weaker signals instead of
 * reporting a confident `false`.
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
   * A stable id for `el`, tagging it with `data-djobi-id` if it has none of its own.
   *
   * A tag already on the element is reused rather than reissued, so an element keeps the same id
   * across repeated scans of the same page. The page is re-scanned as it changes (see `detect.ts`)
   * and again at fill time, and drafted answers are keyed by field id: reissuing ids from a counter
   * that restarts at zero each scan would silently re-point every answer at whichever field now
   * happens to occupy that position in document order.
   */
  id(el: Element): string;
  /**
   * `el`'s id and a CSS selector that resolves back to it. The id is escaped via `CSS.escape` —
   * some ATS platforms (Greenhouse's multi-value fields) use ids like `question_123[]`, which are
   * invalid unescaped in a `#id` selector.
   */
  locate(el: Element): { id: string; selector: string };
  /** A {@link FieldOption} for one choice, tagged so the Fill Step can find that exact element. */
  option(el: Element, label: string): FieldOption;
}

/**
 * A tagger for one scan.
 *
 * The counter lives in this closure rather than in a `{ n: number }` box passed down through every
 * detection function, which is what it used to be: eight signatures carried it alongside `doc`
 * purely to keep one integer moving, and each one had to remember to thread it on.
 */
function createFieldTagger(doc: Document): FieldTagger {
  let next = 0;

  /** The next id not already tagged onto some element — the counter restarts each scan while earlier tags survive in the DOM, so it can otherwise hand out a duplicate. */
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
 * A file input's signal, falling back to the name of the `role="group"` around it.
 *
 * Greenhouse binds *both* of a posting's file inputs to a visually-hidden `<label>Attach</label>`
 * (`docs/ats-platform-detection.md` §Greenhouse ¶4) — the text a human reads, "Resume/CV" or
 * "Cover Letter", is a plain `<div>` referenced by `aria-labelledby` on the enclosing
 * `<div role="group">`. Both inputs therefore signalled the identical, contentless "Attach", both
 * classified `resume_upload` by the default, and the cover-letter slot became a second candidate for
 * the resume.
 *
 * Only consulted when the input's own signal names no file kind of its own, so a field already
 * labelled "Resume" or "Cover letter" is never overruled by a coarser group name around it.
 */
function fileFieldSignal(doc: Document, el: Element, signal: string): string {
  if (categoryFor(FILE_KEYWORD_RULES, signal)) return signal;
  return enclosingGroupName(doc, el) || signal;
}

/** A `?`, or an imperative/question-style opener, marks an unmatched free-text field as a free-response question. */
const QUESTION_SHAPE = /\?|^(why|how|what|describe|tell us|explain)\b/i;

/**
 * A label that opens with an auxiliary verb or a condition is a screening question, whatever else
 * it mentions — and so is never a profile field, however many profile keywords appear inside it.
 *
 * This runs *before* the keyword rules, and that ordering is the point. The rules match their
 * keyword anywhere in the signal, which is right for a field label ("Location (City)") and wrong for
 * prose that merely refers to one: Greenhouse postings ask "Are you authorized to work in the stated
 * location of this role?" and "Do you currently live in, or plan to relocate to, the specified
 * location…", both yes/no choices, and both were classified `location` and filled with the
 * candidate's city instead of being answered.
 *
 * Deliberately only the auxiliary/conditional openers. "Where are you currently located?" and "What
 * country are you based in?" open with an interrogative that introduces the fact being asked for, so
 * they stay profile fields; "Are…/Do…/Have…/If…" ask the candidate to judge something instead.
 */
const SCREENING_QUESTION_SHAPE =
  /^(are|is|was|were|do|does|did|have|has|had|will|would|can|could|should|may|might|if)\b/i;

/**
 * The `if` idiom that qualifies a field rather than asking anything — "If applicable, LinkedIn URL".
 *
 * {@link SCREENING_QUESTION_SHAPE} accepts `if` because Greenhouse's screening questions lead with
 * it ("If you heard about us through a referral, please state…"), and it has to outrank the keyword
 * rules to do its job. That would otherwise also demote "If applicable, please provide your LinkedIn
 * profile URL" to a drafted-prose question, so the field would receive a sentence where a profile URL
 * belongs. These openers are the qualifier, not a condition on anything the candidate must judge.
 */
const CONDITIONAL_QUALIFIER = /^if\s+(applicable|any|none|so|not|known|relevant|available)\b/i;

/**
 * Free-text field types, where a question-shaped label means a free-response question.
 *
 * `search` is deliberately absent. `detectFields` scans the whole document, and `SCAN_PAGE` is not
 * gated on the page-shape heuristic (see `content/index.ts`), so a site header's
 * `<input type="search" placeholder="What are you looking for?">` is in scope — and its placeholder
 * is question-shaped. A search box is for querying the site, never for answering it.
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
 * HTML's standardized autofill field names, mapped onto our categories.
 *
 * This is the one classification signal the page states outright rather than implying, and it costs
 * nothing to read — Chromium's own autofill ranks a parsed `autocomplete` attribute above every
 * local heuristic it has. Only the tokens that correspond to something a candidate profile holds are
 * listed; anything else (`cc-*`, `bday`, `organization`) falls through to the keyword rules.
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

/** Tokens that may precede the field name in an `autocomplete` value without changing what it names. */
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
 * The category named by `el`'s `autocomplete` attribute, if it names one we handle.
 *
 * Parses the spec's token grammar rather than matching the attribute whole, so
 * `autocomplete="section-primary shipping given-name"` still resolves to `first_name`. `off`/`on`
 * carry no field semantics and stop the search.
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
 * Classifies a field by its `autocomplete` attribute, else by keyword-matching its signal text.
 *
 * `inputType` decides only what happens when neither says anything: a file input is a resume upload
 * by default, a `combobox` is inherently a choice prompt so it becomes a `question` unconditionally,
 * and a `textarea` becomes one only if its label reads like a question. Everything else is
 * `unknown`. Keeping that last step here rather than at each call site is the point — the combobox
 * pass used to spell the whole ladder out again, which is two statements of one rule, one file apart.
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
  // Every free-text type, not `textarea` alone. Greenhouse renders its free-response screening
  // questions ("What are your preferred gender pronouns?") as `<input type="text">`, so gating on
  // `textarea` left them `unknown` — never drafted, never filled, including required ones.
  if (FREE_TEXT_INPUT_TYPES.has(inputType) && QUESTION_SHAPE.test(signal)) return 'question';

  return 'unknown';
}

/** Resolves an ARIA-widget's options: `aria-controls`/`aria-owns`'s `role="option"` children, if in the DOM. */
function resolveComboboxOptions(
  doc: Document,
  el: Element,
  tagger: FieldTagger,
): FieldOption[] | undefined {
  const controlsId = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
  if (!controlsId) return undefined;

  const listbox = doc.getElementById(controlsId);
  if (!listbox) return undefined;

  const options = Array.from(listbox.querySelectorAll('[role="option"]'))
    .map((opt) => ({ el: opt, label: collapseWhitespace(opt.textContent ?? '') }))
    .filter((opt) => opt.label !== '')
    .map((opt) => tagger.option(opt.el, opt.label));

  return options.length > 0 ? options : undefined;
}

/**
 * A native `<select>`'s selectable `<option>` elements. Selects previously reported no choices at
 * all, so a select-backed question was drafted with nothing to choose from and could only be filled
 * by matching option text at fill time — the exact fragility this module avoids everywhere else.
 * The empty-valued leading placeholder ("Select…") is skipped: it isn't an answer.
 */
function resolveSelectOptions(el: Element, tagger: FieldTagger): FieldOption[] | undefined {
  if (!isInstanceOf(el, 'HTMLSelectElement')) return undefined;

  const options = Array.from(el.options)
    .filter((opt) => opt.value !== '' && opt.text.trim() !== '')
    .map((opt) => tagger.option(opt, collapseWhitespace(opt.text)));

  return options.length > 0 ? options : undefined;
}

/**
 * Detects `role="combobox"` widgets (react-select-style custom dropdowns) — invisible to the
 * native `input, textarea, select` query. Always promoted to `'question'` when unmatched by a
 * keyword rule; a combobox is inherently a choice prompt, so (unlike free-text fields) it needs
 * no `QUESTION_SHAPE` gate. `options` is left undefined when the widget's option list isn't in
 * the DOM yet (e.g. portal-mounted only once opened) rather than dropping the field.
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
  if (legend) {
    const text = labelText(legend);
    if (text) return text.slice(0, MAX_SIGNAL_LENGTH);
  }

  // No `own !== container.id` guard here. There used to be one, duplicating a rule `getSignal`
  // already enforces internally (see `GENERATED_ID`) — so the caller had to know the callee's
  // fallback ladder, and the two spellings of the same rule could drift apart.
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
    // A group is required when its container says so *or any one of its choices does*. Asking only
    // the container reported every Lever radio group optional: Lever puts `required` on the
    // `<input type="radio">` elements and nothing on the `<ul data-qa="multiple-choice">` around
    // them (`docs/ats-platform-detection.md` §Lever ¶3), so a required screening question — work
    // authorization, sponsorship — was passed along as one the candidate could skip.
    required:
      getRequired(doc, container, marked) ||
      choices.some((choice) => getRequired(doc, choice, choiceLabel(doc, choice))),
    elementRole,
    // Each option keeps a selector to its own element, so the Fill Step never has to repeat this
    // derivation. `choiceLabel` covers ATS markup where an option's label is a `for=id` sibling
    // rather than a wrapper (e.g. Ashby's radio groups), falling back to the input's own `value`
    // only when no label can be found at all.
    options: choices.map((choice) => tagger.option(choice, choiceLabel(doc, choice))),
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
 * Finds every candidate-fillable field on the page and classifies it into a {@link DetectedField},
 * using each field's `<label for>` text (or aria-label/placeholder/name/id fallback) as the
 * classification signal.
 *
 * Three passes, in this order because each narrows what the next may claim: choice groups first
 * (one field per question, consuming their own native inputs), then the native scan over what's
 * left, then `role="combobox"` widgets the native query cannot see.
 *
 * ## What a caller has to know beyond the signature
 *
 * `(doc: Document) => DetectedField[]` is a small type over a large contract. These are the parts
 * that are load-bearing and that the type cannot state:
 *
 * - **This writes to the document.** Any field or option without an `id` of its own is tagged with
 *   `data-djobi-id` so a selector can find it again. A 40-option `<select>` writes 40 attributes.
 * - **So it must not be called from an attribute `MutationObserver`** watching the same document,
 *   which its own tagging would retrigger forever. `detect.ts` filters accordingly; a new caller
 *   has to do the same.
 * - **Return order is `[native…, comboboxes…, groups…]`, not document order.** `content/index.ts`
 *   relies on it when choosing which `resume_upload` input receives the file. Asserted below.
 * - **Ids are stable across scans of the same document, not globally unique over time.** A tag
 *   survives re-scans, but an element's *own* `id` wins when it has one — and React widgets that
 *   remount regenerate theirs, so for exactly the custom widgets this module works hardest to
 *   support, "stable" holds only as long as the element does. `matchAnswerToField` carries a
 *   label-based fallback for that case.
 * - **Repeated scans are id-stable but not side-effect-free.** Each one re-tags; a document already
 *   tagged by an earlier build is inherited as-is.
 * - **`options: undefined` and `options: []` differ.** Undefined means "choices unknown" (a listbox
 *   that mounts on open); empty means "no choices".
 * - **`required` is derived partly from `label`**, so a change to label derivation can change
 *   required-ness.
 * - **`label` may be `''`** when nothing nameable was found.
 *
 * Cost is superlinear in field count — several `querySelectorAll`s per field — so this is a scan to
 * run on a settled DOM, not per keystroke.
 *
 * A document from another realm (`iframe.contentDocument`) is safe to pass: every DOM-class test
 * resolves through {@link isInstanceOf} rather than this realm's globals.
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
        // A framework's hidden validation mirror is not a field a candidate fills — see
        // {@link isRequiredProxy}. Its `required` has already been harvested by `hasRequiredProxy`
        // on behalf of the real widget beside it, which runs off the same wrapper.
        !isRequiredProxy(el),
    )
    .map((el): DetectedField => {
      const inputType = el.type;
      const signal = getSignal(doc, el);
      // The two readings part company for a file input alone: it may be *named* by the group around
      // it (see {@link fileFieldSignal}) while the required marker stays on its own label, so
      // reading the marker off the group's name would report a required upload optional. Nothing is
      // lost by keeping the group out of it — `ariaRequired` walks the ancestors, and `role="group"`
      // is one of the groupings it accepts `aria-required` from.
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
