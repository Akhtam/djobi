import { labelsMatch, normalizeLabel, type DetectedField } from '@djobi/shared';
import { choiceLabel } from './detectFields';

/** Resolves a `DetectedField`'s `selector` to its matching DOM element, or `null` if unresolvable. */
export function resolveField<T extends Element = HTMLElement>(
  doc: Document,
  field: DetectedField,
): T | null {
  return doc.querySelector<T>(field.selector);
}

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
 *
 * `InputEvent` is used in preference to a plain `Event` because handlers that inspect `inputType`
 * or `data` (rich-text and masked-input widgets) treat an `input` event carrying neither as a
 * programmatic write to ignore. It falls back where the constructor is missing (jsdom).
 */
function commitValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  el.focus();
  setNativeValue(el, value);

  const input =
    typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })
      : new Event('input', { bubbles: true });
  el.dispatchEvent(input);
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
 * Finds the element for the choice `value` names, preferring the `selector` `detectFields.ts`
 * recorded for that choice at detection time. That selector is the whole point of
 * {@link FieldOption}: the drafted answer is constrained to one of `field.options`, so matching it
 * back against *that same array* and following the recorded selector closes the round-trip exactly,
 * with no second derivation to disagree with the first.
 *
 * Returns `null` when the choice has no selector — it came from an ATS API schema, or from a
 * listbox that only mounts once opened, so no element existed to tag. Callers fall back to matching
 * label text against the live DOM, which is the only thing possible for a choice we never saw.
 */
function resolveOptionElement<T extends Element = HTMLElement>(
  doc: Document,
  field: DetectedField,
  value: string,
): T | null {
  const option = field.options?.find((candidate) => labelsMatch(candidate.label, value));
  return option?.selector ? doc.querySelector<T>(option.selector) : null;
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

/** Selects a `<select>` option — by the element recorded at detection time, else by visible text. */
function fillSelect(
  doc: Document,
  field: DetectedField,
  el: HTMLSelectElement,
  value: string,
): FillVerifier {
  const match =
    resolveOptionElement<HTMLOptionElement>(doc, field, value) ??
    Array.from(el.options).find((opt) => labelsMatch(opt.text, value));
  if (!match) return FAILED;

  commitValue(el, match.value);
  return () => el.value === match.value;
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
function fillGroup(doc: Document, field: DetectedField, value: string): FillVerifier {
  const recorded = resolveOptionElement<HTMLElement>(doc, field, value);
  if (recorded) {
    recorded.click();
    return () => isChosen(recorded);
  }

  const container = resolveField(doc, field);
  if (!container) return FAILED;

  const choices = Array.from(
    container.querySelectorAll<HTMLElement>(
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], button[aria-pressed]',
    ),
  );
  const match = choices.find((choice) => labelsMatch(choiceLabel(doc, choice), value));
  if (!match) return FAILED;

  match.click();
  return () => isChosen(match);
}

/**
 * Whether a choice reads as selected, across the three ways an ATS expresses it: a native input's
 * `checked`, an ARIA widget's `aria-checked`, and a toggle button's `aria-pressed`. A click that
 * the page's handler ignored leaves all three untouched, which is what makes this a real check.
 */
function isChosen(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
}

/** How long to wait for a combobox's options to appear, as attempts × delay between them. */
const OPTION_WAIT_ATTEMPTS = 20;
const OPTION_WAIT_INTERVAL_MS = 50;

/** Polls `find` until it returns something or the budget runs out. */
async function waitForOption(find: () => Element | undefined): Promise<Element | undefined> {
  for (let attempt = 0; attempt < OPTION_WAIT_ATTEMPTS; attempt++) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, OPTION_WAIT_INTERVAL_MS));
  }
  return find();
}

/**
 * Opens a `role="combobox"` and clicks the choice `value` names.
 *
 * Two kinds of widget hide behind that one role, and the difference is why this isn't just a click.
 * A plain dropdown renders its whole option list on open. A **type-to-search** combobox renders
 * nothing until it has a query — Ashby's location field is one, and its options come back from the
 * network — so clicking it and looking for `[role="option"]` finds an empty list every time and the
 * field is left blank. When the trigger is an `<input>`, this types `value` into it exactly as
 * {@link setNativeValue} does for a text field, which is what makes such a widget search at all.
 *
 * The wait is then a poll rather than a microtask tick, since a searching combobox answers over the
 * network. It gives up quietly: a combobox whose options never arrive leaves the field untouched
 * and reports itself through the run's unresolved-required-fields list rather than throwing.
 *
 * Prefers the element recorded at detection time; falls back to scanning live `[role="option"]`
 * text for a choice that had no element to record.
 */
async function fillCombobox(
  doc: Document,
  field: DetectedField,
  value: string,
): Promise<FillVerifier> {
  const trigger = resolveField(doc, field);
  if (!trigger) return FAILED;

  trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  if (trigger instanceof HTMLInputElement) {
    trigger.focus();
    setNativeValue(trigger, value);
    trigger.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const match = await waitForOption(
    () =>
      resolveOptionElement(doc, field, value) ??
      Array.from(doc.querySelectorAll('[role="option"]')).find((opt) =>
        labelsMatch(opt.textContent ?? '', value),
      ),
  );
  if (!match) return FAILED;

  match.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  // A combobox reports its choice either as the trigger input's text or as the label rendered into
  // the trigger. Both are checked because the two widget shapes behind `role="combobox"` answer to
  // different ones, and a click the widget ignored leaves neither. The rendered-label branch is a
  // containment test rather than `labelsMatch`: a trigger is a container, so its `textContent` can
  // carry a placeholder remnant or an adjacent clear-button's label alongside the choice, and an
  // equality test there would report a perfectly good selection as unfilled.
  return () =>
    trigger instanceof HTMLInputElement
      ? labelsMatch(trigger.value, value)
      : normalizeLabel(trigger.textContent ?? '').includes(normalizeLabel(value));
}

/**
 * How long to let the page react before re-reading what was written. A React form reverts a value
 * its `onChange` never saw on the *next render*, not synchronously, so an immediate re-read
 * reports every failed fill as a success. This is a settle delay, not a poll: there is nothing to
 * wait *for* — a fill that worked already reads back correctly and only loses this much time once
 * per run, at the very end.
 */
const SETTLE_MS = 300;

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
 * given {@link SETTLE_MS} to render, and only fields that still hold their value are reported
 * filled — which is what lets the panel tell the user *which* fields to go fix, rather than
 * showing a green check over a form the ATS will reject as empty.
 */
export async function fillForm(
  doc: Document,
  fields: DetectedField[],
  values: Record<string, string>,
): Promise<string[]> {
  const verifiers: Array<[string, FillVerifier]> = [];

  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;

    if (field.elementRole === 'combobox') {
      verifiers.push([field.id, await fillCombobox(doc, field, value)]);
      continue;
    }

    if (field.elementRole === 'radiogroup' || field.elementRole === 'checkboxgroup') {
      verifiers.push([field.id, fillGroup(doc, field, value)]);
      continue;
    }

    const el = resolveField<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(doc, field);
    if (!el) {
      verifiers.push([field.id, FAILED]);
      continue;
    }

    if (el instanceof HTMLSelectElement) {
      verifiers.push([field.id, fillSelect(doc, field, el, value)]);
      continue;
    }

    commitValue(el, value);
    verifiers.push([field.id, () => el.value === value]);
  }

  if (verifiers.length === 0) return [];

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
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

  if (typeof DataTransfer !== 'undefined') {
    const dt = new DataTransfer();
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
