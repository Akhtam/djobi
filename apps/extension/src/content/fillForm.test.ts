import { afterEach, describe, expect, it } from 'vitest';
import type { DetectedField } from '@djobi/shared';
import { attachResumeFile, fillForm } from './fillForm';

function field(overrides: Partial<DetectedField>): DetectedField {
  return {
    id: 'f1',
    label: 'Email',
    inputType: 'text',
    selector: '#f1',
    category: 'email',
    ...overrides,
  };
}

describe('fillForm', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it("sets a text input's value and dispatches an input event so the page reacts to the change", () => {
    document.body.innerHTML = `<input id="f1" type="text" />`;
    const input = document.querySelector<HTMLInputElement>('#f1')!;
    let inputEventFired = false;
    input.addEventListener('input', () => {
      inputEventFired = true;
    });

    fillForm(document, [field({ id: 'f1', selector: '#f1' })], { f1: 'jane@example.com' });

    expect(input.value).toBe('jane@example.com');
    expect(inputEventFired).toBe(true);
  });

  it('leaves fields with no supplied value untouched and skips selectors that resolve to nothing, without throwing', () => {
    document.body.innerHTML = `<input id="f1" type="text" value="original" /><input id="f2" type="text" />`;

    expect(() =>
      fillForm(
        document,
        [
          field({ id: 'f1', selector: '#f1' }),
          field({ id: 'f2', selector: '#f2' }),
          field({ id: 'f3', selector: '#does-not-exist' }),
        ],
        { f2: 'filled' },
      ),
    ).not.toThrow();

    expect(document.querySelector<HTMLInputElement>('#f1')!.value).toBe('original');
    expect(document.querySelector<HTMLInputElement>('#f2')!.value).toBe('filled');
  });
});

describe('attachResumeFile', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it("sets the file input's files and dispatches a change event", () => {
    document.body.innerHTML = `<input type="file" id="resume" />`;
    const input = document.querySelector<HTMLInputElement>('#resume')!;
    let changeEventFired = false;
    input.addEventListener('change', () => {
      changeEventFired = true;
    });
    const file = new File(['%PDF-1.4 ...'], 'resume.pdf', { type: 'application/pdf' });

    attachResumeFile(input, file);

    expect(input.files).toHaveLength(1);
    expect(input.files?.[0]).toBe(file);
    expect(changeEventFired).toBe(true);
  });
});
