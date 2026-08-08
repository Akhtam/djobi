import type { DetectedField } from '@djobi/shared';

/**
 * Fills every field in `fields` that has a value in `values` (keyed by `DetectedField.id`),
 * locating each element via its `selector` and dispatching an `input` event so the page's own
 * change-handling reacts to the fill, same as a real keystroke would.
 */
export function fillForm(
  doc: Document,
  fields: DetectedField[],
  values: Record<string, string>,
): void {
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;

    const el = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(field.selector);
    if (!el) continue;

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
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
