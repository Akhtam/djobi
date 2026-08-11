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

/** Sets a `<select>`'s value by matching `value` against each `<option>`'s visible text, not its raw `value` attribute. */
function fillSelect(el: HTMLSelectElement, value: string): void {
  const match = Array.from(el.options).find((opt) => normalize(opt.text) === normalize(value));
  if (!match) return;

  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Clicks the radio/checkbox(es) in a group whose label text matches `value` (comma-separated for multi-select). */
function fillGroup(doc: Document, field: DetectedField, value: string): void {
  const container = resolveField(doc, field);
  if (!container) return;

  const wanted = value.split(',').map(normalize);
  const inputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
  );

  for (const input of inputs) {
    // Same label lookup detectFields.ts's `detectFieldsetGroups` uses to build `options` — must
    // stay in sync, or a value drafted against `getSignal`-derived option text (e.g. "Yes and I
    // am local to the San Francisco Bay Area") won't match a `closest('label')`-only lookup here
    // when the ATS associates each option's label via `for=id` rather than wrapping it (Ashby).
    const label = getSignal(doc, input) || input.value;
    if (wanted.includes(normalize(label))) input.click();
  }
}

/**
 * Clicks a `role="combobox"` trigger open, then clicks the `role="option"` matching `value`
 * anywhere in the document — not scoped to the field's pre-detected listbox, since that listbox
 * may be portal-mounted and not exist until the trigger is actually clicked. Waits one microtask
 * tick after the click for the option list to render before searching; no-ops (doesn't throw) if
 * no matching option ever appears.
 */
async function fillCombobox(doc: Document, field: DetectedField, value: string): Promise<void> {
  const trigger = resolveField(doc, field);
  if (!trigger) return;

  trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await Promise.resolve();

  const options = Array.from(doc.querySelectorAll('[role="option"]'));
  const match = options.find((opt) => normalize(opt.textContent ?? '') === normalize(value));
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
      fillSelect(el, value);
      continue;
    }

    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * Attaches `file` to a `<input type="file">` element. `input.files` is a read-only `FileList`
 * with no public constructor, so it can't be assigned directly or built via `DataTransfer`
 * (real Chrome supports `DataTransfer`, but there's no way to construct a `FileList` from
 * outside the engine either way). `Object.defineProperty` shadows the inherited `files` accessor
 * with an own data property, which every engine honors — the same technique DOM testing/
 * automation libraries use for this exact gap.
 */
export function attachResumeFile(input: HTMLInputElement, file: File): void {
  const fileList = Object.assign([file], { item: (index: number) => [file][index] ?? null });
  Object.defineProperty(input, 'files', { value: fileList, configurable: true });

  // Some ATS upload widgets are real drop-target wrappers around the file input and only react
  // to drag/drop events, not `change` — dispatch both so either listener style is covered. jsdom
  // has no `DataTransfer`/`DragEvent` constructors, so a plain `Event` is shadowed the same way
  // `files` is above, mirroring real Chrome's `DataTransfer` shape closely enough for handlers
  // that read `event.dataTransfer.files`.
  const dropzone = input.closest('[class*="drop"], [class*="drag"]') ?? input;
  const dataTransfer = { files: fileList, items: { add: () => {} }, types: ['Files'] };
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    dropzone.dispatchEvent(event);
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));
}
