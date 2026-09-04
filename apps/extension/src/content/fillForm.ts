import { containsLabel, labelsMatch, type DetectedField } from '@djobi/shared';
import { autofillSource } from '../lib/fieldDisposition';
import type { FillFormResult } from '../lib/messages';
import { resolveChoice, resolveField } from './detectedFieldDom';
import { collapseWhitespace, isInstanceOf } from './pageSignals';

/**
 * Writes `value` through the *prototype's* `value` setter rather than assigning `el.value` directly.
 *
 * React tracks a controlled input's value by installing an own-property `value` accessor on the
 * element instance, whose setter updates React's cached copy in lockstep. A plain `el.value = x`
 * therefore hits that instance setter, React's cache moves with it, its change detector sees no
 * difference between the cached and current value, and the `onChange` it would have dispatched
 * never fires — the DOM shows the text but the component's state never learns about it, so the
 * value vanishes on the next render and validation still considers the field empty. Going through
 * the prototype setter bypasses the instance accessor, leaving React's cache stale, so the
 * subsequent `input` event is recognized as a real change.
 *
 * Falls back to direct assignment where the descriptor is missing (older/partial DOM
 * implementations); on an uncontrolled input both paths are equivalent.
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
 * The `input` event a keystroke produces, dispatched at `el`.
 *
 * `InputEvent` is used in preference to a plain `Event` because handlers that inspect `inputType`
 * or `data` (rich-text and masked-input widgets) treat an `input` event carrying neither as a
 * programmatic write to ignore. It falls back where the constructor is missing (jsdom).
 *
 * One implementation, because a text field and a combobox's search box are typed into the same way
 * and used not to be: this half of {@link commitValue} was copied into the combobox path as a bare
 * `Event('input')`, so the widget most in need of looking like a real keystroke got the weakest
 * imitation of one.
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
 * Drives the full mouse sequence a real press produces: `pointerdown`, `mousedown`, `mouseup`,
 * `click`.
 *
 * **A `click` is not a press**, and the difference decides whether a custom dropdown opens at all.
 * react-select — what Greenhouse's current job boards, among others, are built on — binds its
 * control to `onMouseDown` and its dropdown indicator to `onMouseDown`; the only thing it binds
 * `onClick` to is an option. So the lone `click` this used to send at a combobox trigger was a
 * no-op, and the widget opened solely as a side effect of the search text typed after it. That left
 * a combobox which cannot be searched (react-select renders a `readOnly` dummy input for
 * `isSearchable={false}`) with no way to be opened at all.
 *
 * `button: 0` is explicit because handlers routinely ignore a press that isn't the primary button —
 * react-select's own indicator handler checks exactly that — and `cancelable` because those same
 * handlers call `preventDefault()` to keep focus where it is. `PointerEvent` is guarded rather than
 * assumed: it is absent in jsdom, and a widget listening for it is listening for `mousedown` too.
 */
function press(el: Element): void {
  const init = { bubbles: true, cancelable: true, button: 0 };
  if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
}

/**
 * The `keydown`/`keyup` pair a key press produces, dispatched at `el`.
 *
 * Custom widgets are keyboard-operable by construction — ARIA requires it — so the keyboard is the
 * one interface every combobox implementation is obliged to support, and the fallback the retry
 * pass leans on when a press did not take. `key` and `code` are both set because handlers are split
 * over which they read.
 */
function pressKey(el: Element, key: string, modifiers: KeyboardEventInit = {}): void {
  const init = { bubbles: true, cancelable: true, key, code: key, ...modifiers };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/**
 * Brings `el` into view before it is pressed, where the environment can.
 *
 * A menu long enough to scroll is routinely virtualized, and a widget that renders only the rows
 * near the viewport can unmount the row under an out-of-view press between the lookup and the
 * click. Scrolling first also matters for the plain case of a sticky header sitting over the
 * control. Guarded because jsdom has no layout and therefore no `scrollIntoView`.
 */
function scrollIntoView(el: Element): void {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
}

/**
 * Types `value` into the focused `el` through the editing host itself, returning whether it took.
 *
 * `execCommand('insertText')` is the one route from a content script to an input event the browser
 * generates rather than the extension — `isTrusted`, carrying a real `inputType` and preceded by a
 * real `beforeinput`. That distinction is invisible to React, which is why the ordinary path does
 * not need it, but it is exactly what the stricter widgets check: masked and formatted inputs
 * (phone, date, currency) rebuild their value from `beforeinput` and ignore a value that simply
 * appeared, and a few hardened forms drop untrusted events outright. So this is the retry pass's
 * first move on a field that was written and did not stick.
 *
 * Deprecated but not replaced: no standard API dispatches a trusted input event, and every browser
 * still implements this one for editing hosts. It is guarded on every side — absent in jsdom, it
 * throws on a detached or non-editable element, and it silently no-ops where the selection could
 * not be established — so the return value is a re-read of the field rather than its own verdict.
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
 * How hard a fill is trying: `'first'` is the ordinary path, `'retry'` the heavier imitation of a
 * real user run only against the fields a first pass wrote and could not verify — see
 * {@link fillForm}.
 *
 * A mode rather than two code paths, because the retry differs from the first attempt in a handful
 * of details per widget (a trusted keystroke instead of a synthetic one, arrow keys instead of a
 * press) and not in what it is trying to achieve. Keeping the ordinary path unchanged is the point:
 * the extra events are ones a page can legitimately dislike, so they are spent only where the page
 * has already demonstrated that the quiet version does not work.
 */
type FillMode = 'first' | 'retry';

/**
 * Writes `value` and drives the event sequence a real keystroke produces: `focus`, `input`,
 * `change`, then `blur`/`focusout`.
 *
 * {@link setNativeValue} alone is not enough for every ATS. React's own change detection needs only
 * the `input` event, but form libraries layered on top of it commonly hold a field's text in local
 * component state and push it into the *form's* state on blur (`react-hook-form`'s `onBlur` mode is
 * the common case). Under that shape a fill that never blurs leaves the text visible in the DOM
 * while the form model stays empty — which is exactly what a submit-time "missing entry for
 * required field" on a visibly-filled form looks like. Focusing first matters for the mirror-image
 * case: a widget that only starts tracking a field once it has been focused.
 */
function commitValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  mode: FillMode = 'first',
): void {
  el.focus();

  // On a retry, imitate a keystroke rather than merely announcing one: a `keydown` before the value
  // changes and a `keyup` after it, around a trusted insertion where the element can take one. The
  // ordinary path stays a plain write, because these events are the ones a page is entitled to act
  // on (a `keydown` handler that filters characters, a `keyup` that triggers a lookup) and there is
  // no reason to provoke that until the quiet write has been shown not to stick.
  const typed = mode === 'retry' && !isInstanceOf(el, 'HTMLSelectElement');
  if (typed) el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
  if (!typed || !insertText(el as HTMLInputElement | HTMLTextAreaElement, value))
    setNativeValue(el, value);

  dispatchInput(el, value);
  if (typed) el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  // Prefer the real blur, which the browser turns into a `blur` + `focusout` pair; synthesize that
  // pair only for an element that never took focus in the first place (a visually-hidden or
  // `tabindex="-1"` control ignores `focus()`), where `blur()` is a no-op and a commit-on-blur
  // handler would otherwise never run.
  const hadFocus = el.ownerDocument.activeElement === el;
  el.blur();
  if (!hadFocus) {
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
}

/**
 * A check, run after the page has had a chance to re-render, of whether a fill actually stuck.
 *
 * Every fill path returns one. The point is that writing to the DOM and the page's form model
 * accepting the write are different events: a controlled React field whose `onChange` never fired
 * shows the text until the next render and is then reverted, and a combobox whose options never
 * arrived was never given anything at all. Only the deferred re-read can tell those apart from a
 * real fill, and it's what the panel's success report is built from — see {@link fillForm}.
 */
type FillVerifier = () => boolean;

/** A fill that could not even be attempted (no element, no matching option) — never verifies. */
const FAILED: FillVerifier = () => false;

/** Page structure, never one field's widget — the hard stop for {@link widgetRegion}'s walk. */
const STRUCTURAL_TAGS = new Set(['BODY', 'FORM', 'FIELDSET', 'MAIN', 'SECTION', 'ARTICLE']);

/**
 * Parts of a widget that are not its value: the choices it is offering, and what it announces to a
 * screen reader. Both routinely carry the answer's own text — an open menu literally contains the
 * option, and react-select's live region says "option Yes, selected" — so a value read that counted
 * them would confirm every fill it was asked about, including the ones that did nothing.
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
 * The region a combobox renders its *own* state into: the largest ancestor of `trigger` that still
 * holds nothing but this one widget.
 *
 * Needed because a custom dropdown does not necessarily display its choice on the trigger. In a
 * react-select widget the trigger is a search `<input>` whose text is **cleared the instant a
 * choice is made** (`setValue` → `onInputChange('', { action: 'set-value' })`), and the choice is
 * rendered as a `<div>` two levels above it. Reading the trigger alone therefore got the answer
 * backwards on every such field: a successful fill verified as `false`, and a field left holding
 * nothing but abandoned search text verified as `true` — which is how a form could be reported
 * fully filled and still reject every dropdown on it as empty.
 *
 * The walk stops at the first ancestor that holds a second control, the field's `<label>`, or an
 * announcement region, because each is a sign of having left the widget for the field around it.
 * The hidden `<input required>` react-select mounts beside a widget holding no value is exactly
 * such a neighbour; so is the label whose text would otherwise be read as if it were an answer.
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
 * Whether the combobox behind `trigger` now holds `value` — the verifier for both widget shapes.
 *
 * The rendered value comes first, because a widget that displays its choice separately from the
 * trigger has *said* what it holds and there is nothing to infer. Only when no such display exists
 * does the trigger's own text count, which is the plain autocomplete shape (Ashby's location field)
 * where the text is the value.
 *
 * That second branch additionally requires the widget to have collapsed. Search text and a
 * committed choice look identical in an `<input>`, and the one thing that separates them is that a
 * single-select widget closes its menu when it accepts a choice — so a still-expanded combobox has
 * not accepted one, whatever its input says. A widget that leaves its menu open is reported
 * unfilled here, which is the cheap direction to be wrong in: the panel names a field to go check,
 * rather than showing a green check over one the ATS will reject.
 */
function comboboxHolds(trigger: HTMLElement, value: string): boolean {
  if (containsLabel(displayedValue(widgetRegion(trigger)), value)) return true;
  if (!isInstanceOf(trigger, 'HTMLInputElement')) return false;

  return trigger.getAttribute('aria-expanded') !== 'true' && labelsMatch(trigger.value, value);
}

/** Selects a `<select>` option — by the element recorded at detection time, else by visible text. */
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
 * Clicks the choice in a group that `value` names.
 *
 * `value` is one option's label verbatim — the answer-drafting model is constrained to a single
 * choice and nothing joins multiple choices together, so this deliberately does *not* split on
 * commas. It used to, which silently broke every option whose own label contained one
 * ("San Francisco, CA"). Multi-select isn't supported end-to-end today; if it lands, it needs a
 * real value shape rather than a delimiter that collides with the data.
 *
 * The fallback scan looks for ARIA choices as well as native inputs: a group's answers can be
 * `<button role="radio">`s rather than radios (Ashby renders them that way), and `HTMLElement.click`
 * drives both identically.
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

  // Never press a choice that already reads as chosen. A radio absorbs the second press harmlessly,
  // but a checkbox *toggles*: on the retry pass — which by definition runs against a field whose
  // verification failed — a re-press of a box the page did check would turn the correct answer off,
  // and on a group the retry could only ever make worse. The same guard also keeps the first pass
  // from clearing an answer the candidate (or the ATS's own prefill) had already given.
  if (verify()) return verify;

  activateChoice(choice.element, mode);
  return verify;
}

/**
 * Presses one choice: an `<input>` through {@link HTMLElement.click}, anything else through the full
 * {@link press} sequence.
 *
 * The split is about activation behaviour versus handlers. For a native radio or checkbox `click()`
 * is the whole contract — the browser flips `checked` and fires `change` — and nothing is gained by
 * synthesizing the mouse events around it. An **ARIA choice is a `<div>` or a `<button>` with no
 * activation behaviour at all**: whether it registers is entirely down to which event its handler
 * is bound to, and a widget library that binds `onMouseDown` (the same convention that makes a
 * react-select trigger deaf to a lone `click` — see {@link press}) ignored every group answer this
 * module used to send it. Ashby's yes/no buttons are that shape.
 *
 * The retry pass sends the mouse sequence to a native input too, since a page that wraps its own
 * radios in a `mousedown` handler is the remaining explanation for a `click()` that changed nothing.
 */
function activateChoice(el: HTMLElement, mode: FillMode): void {
  scrollIntoView(el);
  if (mode === 'first' && isInstanceOf(el, 'HTMLInputElement')) el.click();
  else press(el);
}

/**
 * Whether a choice reads as selected, across the three ways an ATS expresses it: a native input's
 * `checked`, an ARIA widget's `aria-checked`, and a toggle button's `aria-pressed`. A click that
 * the page's handler ignored leaves all three untouched, which is what makes this a real check.
 */
function isChosen(el: HTMLElement): boolean {
  if (isInstanceOf(el, 'HTMLInputElement')) return el.checked;
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
}

/**
 * The timing this module runs on.
 *
 * Parameters rather than module constants, matching `detect.ts`'s {@link WatchOptions} — the same
 * decision, taken the other way, two files apart. As constants these were unreachable from a test,
 * so `fillForm.test.ts` ran against real timers and the "options never arrive" case spent the full
 * `attempts × interval` budget on every run.
 */
export interface FillOptions {
  /** How long to let the page render before re-reading what was written. Default 300ms. */
  settleMs?: number;
  /** How many times to look for a combobox's options before giving up. Default 20. */
  optionWaitAttempts?: number;
  /** How long to wait between those looks. Default 50ms. */
  optionWaitIntervalMs?: number;
  /**
   * Whether to make a second, heavier attempt at the fields a first pass could not verify.
   * Default `true`; `false` is for tests that assert on the first pass alone.
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
 * Whether `trigger` is a combobox that can be typed into to narrow its choices.
 *
 * `readOnly` is the discriminator, not the tag: react-select renders a real `<input>` either way
 * and marks the `isSearchable={false}` one read-only, and writing into that one accomplishes
 * nothing — such a widget is opened by {@link press} alone, which is the reason that function has to
 * work rather than merely be dispatched.
 */
function isSearchable(trigger: Element): trigger is HTMLInputElement {
  return isInstanceOf(trigger, 'HTMLInputElement') && !trigger.readOnly;
}

/**
 * Takes back the search text typed into a combobox that never offered a matching choice.
 *
 * Search text a widget hasn't accepted renders exactly like a chosen value — it is what put the
 * word "LinkedIn" in a Greenhouse dropdown sitting above "This field is required." — so leaving it
 * there hands the candidate a form that lies about its own state, on the very fields this run is
 * about to report as unfilled. Blurring is what makes the widget let go of it, and it closes the
 * abandoned menu as a side effect, which matters for the *next* field: an option list still hanging
 * open is one more place `resolveChoice` can find a second "Yes" and decline to choose.
 */
function abandonSearch(trigger: HTMLInputElement): void {
  setNativeValue(trigger, '');
  dispatchInput(trigger, '');
  // Escape before blur, because closing is the widget's documented answer to it and a menu left
  // open is one more place the *next* field's `resolveChoice` can find a second matching option.
  // Blur is the backstop for a widget that ignores the key, and what makes it let go of the text.
  pressKey(trigger, 'Escape');
  trigger.blur();
}

/**
 * Whether `option` is the row a keyboard commit would take — the widget's own highlight, read the
 * three ways implementations express it.
 *
 * `aria-activedescendant` on the trigger is the one the ARIA pattern specifies and what react-select
 * and downshift set; `aria-selected` is the fallback for a listbox that marks the row instead; and
 * Radix's `data-highlighted` is neither, being a styling hook that happens to be the only signal it
 * publishes. Reading the highlight is what makes {@link chooseByKeyboard} safe: without it, an Enter
 * is a press on whichever row the widget happens to be pointing at.
 */
function isHighlighted(trigger: Element, option: Element): boolean {
  const active = trigger.getAttribute('aria-activedescendant');
  if (active && option.id && active === option.id) return true;
  return option.getAttribute('aria-selected') === 'true' || option.hasAttribute('data-highlighted');
}

/**
 * Walks an open menu to `match` with `ArrowDown` and commits it with `Enter`, or reports that it
 * could not.
 *
 * The retry pass's route into a combobox that ignored a pressed option. Keyboard operation is the
 * one interface an ARIA combobox is *required* to implement, so a widget that drops synthetic mouse
 * events on its rows — a virtualized list whose rows are pointer-event-transparent, a menu that
 * commits from its own `keydown` handler — still answers to this.
 *
 * It only ever presses Enter on a step where the widget's own highlight has landed on `match`, which
 * is what keeps a blind Enter from committing whichever row happened to be first. Bounded by the
 * number of rows on offer plus one, so a widget that ignores the arrows (or wraps around past the
 * match without ever highlighting it) ends the walk instead of hammering the key.
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
 * Opens a `role="combobox"` and clicks the choice `value` names.
 *
 * Two kinds of widget hide behind that one role, and the difference is why this isn't just a press.
 * A plain dropdown renders its whole option list on open. A **type-to-search** combobox renders
 * nothing until it has a query — Ashby's location field is one, and its options come back from the
 * network — so opening it and looking for `[role="option"]` finds an empty list every time and the
 * field is left blank. Where the trigger can be searched, this types `value` into it exactly as
 * {@link setNativeValue} does for a text field, which is what makes such a widget search at all.
 *
 * The wait is then a poll rather than a microtask tick, since a searching combobox answers over the
 * network. It gives up quietly: a combobox whose options never arrive is put back the way it was
 * found and reports itself through the run's unresolved-required-fields list rather than throwing.
 *
 * Prefers the element recorded at detection time; falls back to scanning live `[role="option"]`
 * text for a choice that had no element to record. The choice is pressed rather than clicked for
 * the same reason the trigger is — nothing guarantees which of the two a widget listens for.
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

  // A widget that did not open on the press gets the keyboard's version of the same request. Both
  // keys are sent because implementations disagree about which opens a closed combobox, and a
  // widget already open treats either as a move within the menu, which the highlight walk below
  // then corrects.
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

  // `resolveChoice` is re-asked rather than the option list re-read, because for a searching
  // combobox the recorded element and the live ones both arrive late, and it is the one place that
  // knows which of them this field is allowed to claim.
  const match = await waitForOption(() => {
    const choice = resolveChoice(doc, field, value);
    return choice.ok ? choice.element : undefined;
  }, options);

  if (!match) {
    if (searchable) abandonSearch(trigger);
    return FAILED;
  }

  const verify = () => comboboxHolds(trigger, value);

  // Keyboard first on the retry, mouse first otherwise. On a field that reached the retry pass the
  // press is the move already known not to have worked, and {@link chooseByKeyboard} declines
  // rather than guessing when it cannot see its row highlighted — so the press stays as its
  // fallback, not the other way round.
  if (mode === 'retry' && chooseByKeyboard(trigger, match)) return verify;

  scrollIntoView(match);
  press(match);
  return verify;
}

/**
 * Fills every field in `fields` that has a value in `values` (keyed by `DetectedField.id`), and
 * returns the ids of the fields whose value was still there afterwards.
 *
 * Each field is located via its `selector` and driven through the event sequence a real keystroke
 * produces (see {@link commitValue}); non-native fields (`elementRole` other than `'native'`) get
 * widget-appropriate interaction instead.
 *
 * **The return value is the point of the second phase.** Writing to the DOM is not the same event
 * as the page's form model accepting the write, and the ways they come apart are the ATS failures
 * this project keeps hitting: a controlled input whose `onChange` never fired, a combobox whose
 * options never arrived, a `data-djobi-id` on a node the form has since re-mounted. All of them
 * leave a fill looking done from here. So every path returns a {@link FillVerifier}, the page is
 * given `settleMs` to render, and only fields that still hold their value are reported filled —
 * which is what lets the panel tell the user *which* fields to go fix, rather than showing a green
 * check over a form the ATS will reject as empty.
 *
 * That settle is a delay, not a poll: there is nothing to wait *for*, since a fill that worked
 * already reads back correctly. It costs its budget once per sweep, at the very end of it.
 *
 * **A field that fails verification is then tried a second time, harder** ({@link FillMode}), and
 * only the fields that fail twice are reported unfilled. The retry is not a repetition: it swaps a
 * synthetic keystroke for a browser-generated one, a pressed menu row for arrow keys and Enter, a
 * `click()` for the full mouse sequence — the moves a page can distinguish from a real user's, in
 * the order that the ATSes this project has hit actually distinguish them. Scoping it to the failed
 * fields is what makes those moves affordable: the extra events are ones a page is entitled to
 * react to, so they are spent only where the quiet version has already been shown not to work, and
 * a form that filled cleanly pays nothing beyond the one settle.
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
 * Fills `fields` in one sweep, settles, and returns the ids that verified.
 *
 * The write loop stays synchronous for every widget that can be written synchronously — a caller
 * that never awaits (nothing in the extension, but several tests) still sees its text fields
 * written — and awaits only the comboboxes, which have a menu to wait for.
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
 * Attaches `file` to an `<input type="file">` and lets the page's own upload handling react to it.
 *
 * Chrome supports building a real `FileList` via `DataTransfer` and assigning it — the HTML
 * Standard makes `input.files` settable ("On setting, it must run these steps"), so this is the
 * spec-sanctioned route and produces a genuine `FileList` indistinguishable from a user's pick.
 * Only jsdom lacks `DataTransfer`, which is why the shim below still exists; it's a
 * test-environment fallback, not the production path.
 *
 * The constructor comes from `input`'s own realm rather than this module's global, for the same
 * reason every DOM-class test here goes through `pageSignals.isInstanceOf`: a `FileList` minted in
 * one realm and assigned to an element in another is a cross-realm object, which is exactly the
 * kind of thing an implementation is entitled to reject.
 *
 * The event order matters. Upload widgets built on react-dropzone (Ashby's is) accept *either* a
 * `change` on the hidden input or a `drop` carrying a `DataTransfer`, and this used to fire a
 * synthetic drag sequence first. That sequence carried a hand-rolled `dataTransfer` whose `items`
 * was `{ add: () => {} }` — truthy, so react-dropzone's file-selector took its `items` branch,
 * found no `length`, and extracted zero files, running the page's `onDrop` with empty accepted
 * *and* rejected lists before the good `change` ever arrived. `change` now goes first, and the
 * drag sequence only runs as a fallback for widgets that ignore it, carrying a real `DataTransfer`
 * so the `items` branch resolves to the actual file.
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

/** Fills a frame already known to own at least one requested field and assembles its full result. */
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
 * Fills this frame and returns its complete report, or synchronously returns `null` when this frame
 * owns none of the requested fields and therefore must stay silent in a multi-frame message race.
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
