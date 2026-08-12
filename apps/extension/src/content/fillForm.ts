import type { DetectedField } from '@djobi/shared';
import { getSignal } from './detectFields';

/** Resolves a `DetectedField`'s `selector` to its matching DOM element, or `null` if unresolvable. */
export function resolveField<T extends Element = HTMLElement>(
  doc: Document,
  field: DetectedField,
): T | null {
  return doc.querySelector<T>(field.selector);
}

const normalize = (text: string) => text.trim().toLowerCase();

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
  const option = field.options?.find(
    (candidate) => normalize(candidate.label) === normalize(value),
  );
  return option?.selector ? doc.querySelector<T>(option.selector) : null;
}

/** Selects a `<select>` option — by the element recorded at detection time, else by visible text. */
function fillSelect(
  doc: Document,
  field: DetectedField,
  el: HTMLSelectElement,
  value: string,
): void {
  const match =
    resolveOptionElement<HTMLOptionElement>(doc, field, value) ??
    Array.from(el.options).find((opt) => normalize(opt.text) === normalize(value));
  if (!match) return;

  setNativeValue(el, match.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Clicks the radio/checkbox in a group that `value` names.
 *
 * `value` is one option's label verbatim — the answer-drafting model is constrained to a single
 * choice and nothing joins multiple choices together, so this deliberately does *not* split on
 * commas. It used to, which silently broke every option whose own label contained one
 * ("San Francisco, CA"). Multi-select isn't supported end-to-end today; if it lands, it needs a
 * real value shape rather than a delimiter that collides with the data.
 */
function fillGroup(doc: Document, field: DetectedField, value: string): void {
  const recorded = resolveOptionElement<HTMLInputElement>(doc, field, value);
  if (recorded) {
    recorded.click();
    return;
  }

  const container = resolveField(doc, field);
  if (!container) return;

  const inputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
  );
  const match = inputs.find(
    (input) => normalize(getSignal(doc, input) || input.value) === normalize(value),
  );
  match?.click();
}

/**
 * Clicks a `role="combobox"` trigger open, then clicks the choice `value` names. Waits one
 * microtask tick after opening for the option list to render, since it may be portal-mounted and
 * not exist until the trigger is actually clicked. No-ops (doesn't throw) if the choice never
 * appears.
 *
 * Prefers the element recorded at detection time; falls back to scanning live `[role="option"]`
 * text for a choice that had no element to record.
 */
async function fillCombobox(doc: Document, field: DetectedField, value: string): Promise<void> {
  const trigger = resolveField(doc, field);
  if (!trigger) return;

  trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await Promise.resolve();

  const match =
    resolveOptionElement(doc, field, value) ??
    Array.from(doc.querySelectorAll('[role="option"]')).find(
      (opt) => normalize(opt.textContent ?? '') === normalize(value),
    );
  match?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * Fills every field in `fields` that has a value in `values` (keyed by `DetectedField.id`),
 * locating each element via its `selector` and dispatching an `input` event so the page's own
 * change-handling reacts to the fill, same as a real keystroke would. Non-native fields
 * (`elementRole` other than `'native'`) get widget-appropriate interaction instead.
 */
export async function fillForm(
  doc: Document,
  fields: DetectedField[],
  values: Record<string, string>,
): Promise<void> {
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;

    if (field.elementRole === 'combobox') {
      await fillCombobox(doc, field, value);
      continue;
    }

    if (field.elementRole === 'radiogroup' || field.elementRole === 'checkboxgroup') {
      fillGroup(doc, field, value);
      continue;
    }

    const el = resolveField<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(doc, field);
    if (!el) continue;

    if (el instanceof HTMLSelectElement) {
      fillSelect(doc, field, el, value);
      continue;
    }

    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
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
    dataTransfer = { files: fileList, items: fileList.map((f) => ({ kind: 'file', getAsFile: () => f })), types: ['Files'] };
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
