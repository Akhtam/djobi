import { containsLabel, labelsMatch, type DetectedField } from '@djobi/shared';
import { autofillSource } from '../lib/fieldDisposition';
import type { FillFormResult } from '../lib/messages';
import { resolveChoice, resolveField } from './detectedFieldDom';
import { collapseWhitespace, isInstanceOf } from './pageSignals';

/**
 * Writes `value` through the *prototype's* `value` setter. React tracks a controlled input with an
 * instance-level accessor; assigning `el.value` updates its cache too, so no `onChange` fires and
 * the value is lost on the next render. Falls back to direct assignment if the descriptor is
 * missing.
 */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/**
 * Dispatches the `input` event a keystroke produces. `InputEvent` (not `Event`) because some
 * widgets ignore an `input` without `inputType`/`data`; falls back where it's missing (jsdom).
 */
function dispatchInput(el: HTMLElement, value: string): void {
  const inputType = value === '' ? 'deleteContentBackward' : 'insertText';
  el.dispatchEvent(
    typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, data: value, inputType })
      : new Event('input', { bubbles: true }),
  );
}

/**
 * The full press sequence: `pointerdown`, `mousedown`, `mouseup`, `click`. A lone `click` isn't a
 * press — react-select opens on `onMouseDown`, so a non-searchable one couldn't be opened at all.
 * `button: 0` and `cancelable` match what such handlers check; `PointerEvent` is guarded (jsdom).
 */
function press(el: Element): void {
  const init = { bubbles: true, cancelable: true, button: 0 };
  if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
}

/**
 * A `keydown`/`keyup` pair. ARIA widgets must support the keyboard, so it's the retry pass's
 * fallback. Sets both `key` and `code` since handlers differ.
 */
function pressKey(el: Element, key: string, modifiers: KeyboardEventInit = {}): void {
  const init = { bubbles: true, cancelable: true, key, code: key, ...modifiers };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/**
 * Scrolls `el` into view before pressing it (virtualized menus unmount off-screen rows; sticky
 * headers cover controls). Guarded: jsdom has no layout.
 */
function scrollIntoView(el: Element): void {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
}

/**
 * Types `value` via `execCommand('insertText')` — the only way to get a *trusted* input event (with
 * a real `beforeinput`), which masked/formatted inputs and hardened forms require. The retry pass's
 * first move. Deprecated but universally implemented; guarded, and the result is a re-read of the
 * field.
 */
function insertText(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  const doc = el.ownerDocument;
  if (value === '' || typeof doc.execCommand !== 'function') return false;

  try {
    el.select();
    doc.execCommand('insertText', false, value);
  } catch {
    return false;
  }

  return el.value === value;
}

/**
 * `'first'` is the ordinary fill; `'retry'` is a heavier imitation of a real user, used only on
 * fields the first pass couldn't verify — its extra events are ones a page may legitimately react
 * to.
 */
type FillMode = 'first' | 'retry';

/**
 * Writes `value` with a keystroke's event sequence: `focus`, `input`, `change`, then
 * `blur`/`focusout`. The blur matters for form libraries that commit on blur (e.g.
 * `react-hook-form` `onBlur` mode); the focus for widgets that only track focused fields.
 */
function commitValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  mode: FillMode = 'first',
): void {
  el.focus();

  // On retry, add `keydown`/`keyup` around a trusted insertion where possible. Not on the first
  // pass: pages may act on these events, so they're spent only after a quiet write failed.
  const typed = mode === 'retry' && !isInstanceOf(el, 'HTMLSelectElement');
  if (typed) el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
  if (!typed || !insertText(el as HTMLInputElement | HTMLTextAreaElement, value))
    setNativeValue(el, value);

  dispatchInput(el, value);
  if (typed) el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  // Prefer a real blur; synthesize `blur` + `focusout` only if the element never took focus (hidden
  // or `tabindex="-1"`), where `blur()` would be a no-op.
  const hadFocus = el.ownerDocument.activeElement === el;
  el.blur();
  if (!hadFocus) {
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
}

/**
 * A deferred check of whether a fill stuck. The DOM holding a value isn't the form model accepting
 * it (a reverted controlled field, a combobox that never got options); only a re-read after the
 * page re-renders tells them apart. The panel's report is built from these.
 */
type FillVerifier = () => boolean;

/** A fill that could not even be attempted (no element, no matching option) — never verifies. */
const FAILED: FillVerifier = () => false;

/** Page structure, never one field's widget — the hard stop for {@link widgetRegion}'s walk. */
const STRUCTURAL_TAGS = new Set(['BODY', 'FORM', 'FIELDSET', 'MAIN', 'SECTION', 'ARTICLE']);

/**
 * Parts of a widget that aren't its value — the open menu and screen-reader announcements — which
 * often contain the answer text and would falsely confirm a fill.
 */
const NOT_A_VALUE =
  '[role="listbox"], [role="option"], [aria-live], [role="log"], [role="status"], [role="alert"], [aria-hidden="true"]';

/** Whether `el` holds something belonging to the *field* rather than to one widget inside it. */
function isFieldScope(el: Element): boolean {
  return (
    el.querySelectorAll('input, select, textarea, [role="combobox"]').length > 1 ||
    el.querySelector('label') !== null ||
    el.querySelector('[aria-live], [role="log"], [role="status"]') !== null
  );
}

/**
 * The region a combobox renders its own state into: the largest ancestor of `trigger` holding only
 * this widget. Needed because react-select clears its input on selection and renders the choice two
 * levels up — reading the trigger alone inverts the verdict. Stops at a second control, the field's
 * `<label>`, or an announcement region.
 */
function widgetRegion(trigger: Element): Element {
  let region: Element = trigger;

  for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
    if (STRUCTURAL_TAGS.has(parent.tagName) || isFieldScope(parent)) break;
    region = parent;
  }

  return region;
}

/** The text `region` renders as its current value, with {@link NOT_A_VALUE} taken out of it. */
function displayedValue(region: Element): string {
  const copy = region.cloneNode(true) as Element;
  for (const part of copy.querySelectorAll(NOT_A_VALUE)) part.remove();
  return collapseWhitespace(copy.textContent ?? '');
}

/**
 * Whether the combobox behind `trigger` holds `value`. A separately rendered value wins; otherwise
 * the trigger's own text counts (plain autocomplete, e.g. Ashby location) — but only once the menu
 * has collapsed, since search text and a committed choice look the same. An open menu reads as
 * unfilled: the cheap direction to be wrong.
 */
function comboboxHolds(trigger: HTMLElement, value: string): boolean {
  if (containsLabel(displayedValue(widgetRegion(trigger)), value)) return true;
  if (!isInstanceOf(trigger, 'HTMLInputElement')) return false;

  return trigger.getAttribute('aria-expanded') !== 'true' && labelsMatch(trigger.value, value);
}

/**
 * Selects a `<select>` option — by the element recorded at detection time, else by visible text.
 */
function fillSelect(
  doc: Document,
  field: DetectedField,
  el: HTMLSelectElement,
  value: string,
  mode: FillMode,
): FillVerifier {
  const choice = resolveChoice(doc, field, value);
  if (!choice.ok) return FAILED;

  const { value: optionValue } = choice.element as HTMLOptionElement;
  commitValue(el, optionValue, mode);
  return () => el.value === optionValue;
}

/**
 * Clicks the choice in a group that `value` names. `value` is one label verbatim — never split on
 * commas ("San Francisco, CA"); multi-select isn't supported. The fallback scan includes ARIA
 * choices (Ashby's `<button role="radio">`).
 */
function fillGroup(
  doc: Document,
  field: DetectedField,
  value: string,
  mode: FillMode,
): FillVerifier {
  const choice = resolveChoice(doc, field, value);
  if (!choice.ok) return FAILED;

  const verify = () => isChosen(choice.element);

  // Never press a choice that already reads as chosen: a checkbox toggles, so a retry could turn a
  // correct answer off, and a prefilled answer would be cleared.
  if (verify()) return verify;

  activateChoice(choice.element, mode);
  return verify;
}

/**
 * Presses one choice: native inputs via `click()` (the browser flips `checked` and fires `change`);
 * ARIA choices via the full {@link press} sequence, since they have no activation behavior and may
 * listen on `mousedown` (Ashby's yes/no buttons). The retry sends the full sequence to native
 * inputs too.
 */
function activateChoice(el: HTMLElement, mode: FillMode): void {
  scrollIntoView(el);
  if (mode === 'first' && isInstanceOf(el, 'HTMLInputElement')) el.click();
  else press(el);
}

/**
 * Whether a choice reads as selected: `checked`, `aria-checked` or `aria-pressed`. An ignored click
 * changes none, so this is a real check.
 */
function isChosen(el: HTMLElement): boolean {
  if (isInstanceOf(el, 'HTMLInputElement')) return el.checked;
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
}

/** Timing, as parameters so tests can shrink it (like `detect.ts`'s {@link WatchOptions}). */
export interface FillOptions {
  /** How long to let the page render before re-reading what was written. Default 300ms. */
  settleMs?: number;
  /** How many times to look for a combobox's options before giving up. Default 20. */
  optionWaitAttempts?: number;
  /** How long to wait between those looks. Default 50ms. */
  optionWaitIntervalMs?: number;
  /**
   * Retry unverified fields with a heavier pass. Default `true`; tests of the first pass set
   * `false`.
   */
  retryUnverified?: boolean;
}

/** Defaults for {@link FillOptions}, resolved once per {@link fillForm} call. */
const DEFAULT_FILL_OPTIONS = {
  settleMs: 300,
  optionWaitAttempts: 20,
  optionWaitIntervalMs: 50,
  retryUnverified: true,
} satisfies Required<FillOptions>;

type ResolvedFillOptions = Required<FillOptions>;

/** Polls `find` until it returns something or the budget runs out. */
async function waitForOption(
  find: () => HTMLElement | undefined,
  options: ResolvedFillOptions,
): Promise<HTMLElement | undefined> {
  for (let attempt = 0; attempt < options.optionWaitAttempts; attempt++) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, options.optionWaitIntervalMs));
  }
  return find();
}

/**
 * Whether the combobox can be typed into. `readOnly` decides: react-select's non-searchable variant
 * is a read-only `<input>` opened only by {@link press}.
 */
function isSearchable(trigger: Element): trigger is HTMLInputElement {
  return isInstanceOf(trigger, 'HTMLInputElement') && !trigger.readOnly;
}

/**
 * Clears search text from a combobox that offered no matching choice — unaccepted text looks like a
 * chosen value. Blurring also closes the menu, so the next field's `resolveChoice` won't see its
 * options.
 */
function abandonSearch(trigger: HTMLInputElement): void {
  setNativeValue(trigger, '');
  dispatchInput(trigger, '');
  // Escape closes the menu; blur is the backstop and makes the widget drop the text.
  pressKey(trigger, 'Escape');
  trigger.blur();
}

/**
 * Whether `option` is the widget's highlighted row — via the trigger's `aria-activedescendant`
 * (react-select, downshift), the row's `aria-selected`, or Radix's `data-highlighted`. Lets
 * {@link chooseByKeyboard} press Enter only on the right row.
 */
function isHighlighted(trigger: Element, option: Element): boolean {
  const active = trigger.getAttribute('aria-activedescendant');
  if (active && option.id && active === option.id) return true;
  return option.getAttribute('aria-selected') === 'true' || option.hasAttribute('data-highlighted');
}

/**
 * Arrows down an open menu to `match` and commits with Enter, or reports failure — the retry pass's
 * route into comboboxes that ignore synthetic mouse events. Enter only once `match` is highlighted;
 * bounded by the row count plus one.
 */
function chooseByKeyboard(trigger: HTMLElement, match: HTMLElement): boolean {
  const rows = match.parentElement?.querySelectorAll('[role="option"]').length ?? 0;

  for (let step = 0; step <= rows; step++) {
    if (isHighlighted(trigger, match)) {
      scrollIntoView(match);
      pressKey(trigger, 'Enter');
      return true;
    }
    pressKey(trigger, 'ArrowDown');
  }

  return false;
}

/**
 * Opens a `role="combobox"` and chooses the option `value` names.
 *
 * Searchable comboboxes (e.g. Ashby's location field) render no options until they have a query, so
 * `value` is typed in first. Options may arrive over the network, so this polls; if none arrive the
 * widget is restored and the field is reported unresolved, not thrown. Prefers the recorded option
 * element, else a live text match; the option is pressed, not just clicked.
 */
async function fillCombobox(
  doc: Document,
  field: DetectedField,
  value: string,
  options: ResolvedFillOptions,
  mode: FillMode,
): Promise<FillVerifier> {
  const trigger = resolveField(doc, field);
  if (!trigger) return FAILED;

  scrollIntoView(trigger);
  press(trigger);

  // On retry, if the press didn't open it, try the keyboard (both keys, since widgets disagree).
  if (mode === 'retry') {
    trigger.focus();
    pressKey(trigger, 'ArrowDown');
    if (trigger.getAttribute('aria-expanded') !== 'true')
      pressKey(trigger, 'ArrowDown', { altKey: true });
  }

  const searchable = isSearchable(trigger);
  if (searchable) {
    trigger.focus();
    setNativeValue(trigger, value);
    dispatchInput(trigger, value);
  }

  // Re-ask `resolveChoice` each poll: both recorded and live options may arrive late, and it knows
  // which this field may claim.
  const match = await waitForOption(() => {
    const choice = resolveChoice(doc, field, value);
    return choice.ok ? choice.element : undefined;
  }, options);

  if (!match) {
    if (searchable) abandonSearch(trigger);
    return FAILED;
  }

  const verify = () => comboboxHolds(trigger, value);

  // Keyboard first on retry (the press already failed); `chooseByKeyboard` declines rather than
  // guessing, so the press remains the fallback.
  if (mode === 'retry' && chooseByKeyboard(trigger, match)) return verify;

  scrollIntoView(match);
  press(match);
  return verify;
}

/**
 * Fills every field that has a value in `values` (by `DetectedField.id`) and returns the ids whose
 * value was still there afterwards.
 *
 * Every write returns a {@link FillVerifier}; after `settleMs` only fields that still hold their
 * value count as filled, so the panel can name the fields to fix. Fields that fail are retried once
 * with {@link FillMode} `'retry'` (trusted typing, keyboard menu navigation, full mouse sequences);
 * only those failing twice are reported unfilled. A clean form pays for one settle.
 */
export async function fillForm(
  doc: Document,
  fields: DetectedField[],
  values: Record<string, string>,
  fillOptions: FillOptions = {},
): Promise<string[]> {
  const options = { ...DEFAULT_FILL_OPTIONS, ...fillOptions };
  const requested = fields.filter((field) => values[field.id] !== undefined);
  if (requested.length === 0) return [];

  const filled = await runPass(doc, requested, values, options, 'first');
  const unverified = requested.filter((field) => !filled.includes(field.id));
  if (unverified.length === 0 || !options.retryUnverified) return filled;

  return [...filled, ...(await runPass(doc, unverified, values, options, 'retry'))];
}

/**
 * One sweep: fill, settle, return the ids that verified. Synchronous widgets are written
 * synchronously; only comboboxes are awaited.
 */
async function runPass(
  doc: Document,
  fields: DetectedField[],
  values: Record<string, string>,
  options: ResolvedFillOptions,
  mode: FillMode,
): Promise<string[]> {
  const verifiers: Array<[string, FillVerifier]> = [];

  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;

    if (field.elementRole === 'combobox') {
      verifiers.push([field.id, await fillCombobox(doc, field, value, options, mode)]);
      continue;
    }

    if (field.elementRole === 'radiogroup' || field.elementRole === 'checkboxgroup') {
      verifiers.push([field.id, fillGroup(doc, field, value, mode)]);
      continue;
    }

    const el = resolveField<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(doc, field);
    if (!el) {
      verifiers.push([field.id, FAILED]);
      continue;
    }

    if (isInstanceOf(el, 'HTMLSelectElement')) {
      verifiers.push([field.id, fillSelect(doc, field, el, value, mode)]);
      continue;
    }

    commitValue(el, value, mode);
    verifiers.push([field.id, () => el.value === value]);
  }

  await new Promise((resolve) => setTimeout(resolve, options.settleMs));
  return verifiers.filter(([, verify]) => verify()).map(([id]) => id);
}

/**
 * Attaches `file` to an `<input type="file">` by assigning a real `DataTransfer`-built `FileList`
 * (spec-sanctioned; the shim below is for jsdom only), using the input's own realm's constructor.
 *
 * `change` fires first; a drag-and-drop sequence with a real `DataTransfer` follows only as a
 * fallback. Order matters for react-dropzone (Ashby), which accepts either but mishandles a drop
 * without real `items`.
 */
export function attachResumeFile(input: HTMLInputElement, file: File): void {
  let dataTransfer: DataTransfer | { files: unknown; items: unknown; types: string[] };
  const RealmDataTransfer = input.ownerDocument.defaultView?.DataTransfer;

  if (RealmDataTransfer) {
    const dt = new RealmDataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    dataTransfer = dt;
  } else {
    // jsdom: no `DataTransfer` constructor and no way to build a `FileList`, so shadow the
    // inherited `files` accessor with an own data property that quacks like one.
    const fileList = Object.assign([file], { item: (index: number) => [file][index] ?? null });
    Object.defineProperty(input, 'files', { value: fileList, configurable: true });
    dataTransfer = {
      files: fileList,
      items: fileList.map((f) => ({ kind: 'file', getAsFile: () => f })),
      types: ['Files'],
    };
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Some ATS upload widgets are drop-target wrappers that only listen for drag/drop, never
  // `change`. The events bubble, so dispatching at the input reaches an ancestor dropzone too.
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    input.dispatchEvent(event);
  }
}

/** Whether this frame owns any field in the fill command. Must remain synchronous for messaging. */
function ownsAnyField(doc: Document, fields: DetectedField[]): boolean {
  return fields.some((field) => resolveField(doc, field) !== null);
}

/**
 * Fills a frame already known to own at least one requested field and assembles its full result.
 */
async function fillOwnedPage(
  doc: Document,
  fields: DetectedField[],
  values: Record<string, string>,
  resumeFile: File | undefined,
  fillOptions: FillOptions,
): Promise<FillFormResult> {
  const filledFieldIds = await fillForm(doc, fields, values, fillOptions);
  let resumeAttached = false;

  if (resumeFile) {
    // Some ATS platforms render an unlabeled decoy alongside the validated upload. Required wins;
    // field order is only the tie-break between equally eligible inputs.
    const isResume = (field: DetectedField) => autofillSource(field.category) === 'resume';
    const uploadField =
      fields.find((field) => isResume(field) && field.required) ?? fields.find(isResume);
    const input = uploadField ? resolveField<HTMLInputElement>(doc, uploadField) : null;

    if (input) {
      attachResumeFile(input, resumeFile);
      resumeAttached = (input.files?.length ?? 0) > 0;
    }
  }

  return { ok: true, filledFieldIds, resumeAttached };
}

/**
 * Fills this frame and returns its report, or synchronously returns `null` when this frame owns
 * none of the fields — so it stays silent in a multi-frame message race.
 */
export function fillPage(
  doc: Document,
  fields: DetectedField[],
  values: Record<string, string>,
  resumeFile?: File,
  fillOptions: FillOptions = {},
): Promise<FillFormResult> | null {
  if (!ownsAnyField(doc, fields)) return null;
  return fillOwnedPage(doc, fields, values, resumeFile, fillOptions);
}
