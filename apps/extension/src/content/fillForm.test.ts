import { afterEach, describe, expect, it } from 'vitest';
import type { DetectedField } from '@djobi/shared';
import { attachResumeFile, fillForm, resolveField } from './fillForm';

function field(overrides: Partial<DetectedField>): DetectedField {
  return {
    id: 'f1',
    label: 'Email',
    inputType: 'text',
    selector: '#f1',
    category: 'email',
    required: false,
    elementRole: 'native',
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

  it('fills a native select by matching the option text, not the raw option value', () => {
    document.body.innerHTML = `
      <select id="f1">
        <option value="">Select...</option>
        <option value="opt_yes">Yes</option>
        <option value="opt_no">No</option>
      </select>
    `;

    fillForm(document, [field({ id: 'f1', selector: '#f1', inputType: 'select' })], {
      f1: ' yes ',
    });

    expect(document.querySelector<HTMLSelectElement>('#f1')!.value).toBe('opt_yes');
  });

  it('leaves a select untouched when no option matches the given value', () => {
    document.body.innerHTML = `
      <select id="f1">
        <option value="opt_yes" selected>Yes</option>
        <option value="opt_no">No</option>
      </select>
    `;

    expect(() =>
      fillForm(document, [field({ id: 'f1', selector: '#f1', inputType: 'select' })], {
        f1: 'Maybe',
      }),
    ).not.toThrow();

    expect(document.querySelector<HTMLSelectElement>('#f1')!.value).toBe('opt_yes');
  });

  it('checks the matching radio in a radiogroup and leaves siblings unchecked', () => {
    document.body.innerHTML = `
      <fieldset id="f1">
        <label><input type="radio" name="auth" value="yes" />Yes</label>
        <label><input type="radio" name="auth" value="no" />No</label>
      </fieldset>
    `;

    fillForm(
      document,
      [field({ id: 'f1', selector: '#f1', elementRole: 'radiogroup', options: ['Yes', 'No'] })],
      { f1: 'Yes' },
    );

    const [yes, no] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(yes.checked).toBe(true);
    expect(no.checked).toBe(false);
  });

  it("checks the matching radio when its label is a `for=id` sibling rather than a wrapper (e.g. Ashby's markup)", () => {
    document.body.innerHTML = `
      <fieldset id="f1">
        <span><input type="radio" id="opt-a" name="office" /></span>
        <label for="opt-a">Yes and I am local</label>
        <span><input type="radio" id="opt-b" name="office" /></span>
        <label for="opt-b">No and I am not willing</label>
      </fieldset>
    `;

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'radiogroup',
          options: ['Yes and I am local', 'No and I am not willing'],
        }),
      ],
      { f1: 'Yes and I am local' },
    );

    const [yes, no] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(yes.checked).toBe(true);
    expect(no.checked).toBe(false);
  });

  it('checks multiple checkboxes in a checkboxgroup for a comma-separated value', () => {
    document.body.innerHTML = `
      <fieldset id="f1">
        <label><input type="checkbox" value="ts" />TypeScript</label>
        <label><input type="checkbox" value="py" />Python</label>
        <label><input type="checkbox" value="go" />Go</label>
      </fieldset>
    `;

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'checkboxgroup',
          options: ['TypeScript', 'Python', 'Go'],
        }),
      ],
      { f1: 'TypeScript, Go' },
    );

    const [ts, py, go] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(ts.checked).toBe(true);
    expect(py.checked).toBe(false);
    expect(go.checked).toBe(true);
  });

  it('clicks a combobox trigger open, then clicks the matching option once it renders', async () => {
    document.body.innerHTML = `
      <div id="portal"></div>
      <input id="f1" role="combobox" aria-expanded="false" />
    `;
    const trigger = document.querySelector<HTMLInputElement>('#f1')!;
    trigger.addEventListener('click', () => {
      document.querySelector('#portal')!.innerHTML = `
        <ul role="listbox">
          <li role="option">Yes</li>
          <li role="option">No</li>
        </ul>
      `;
    });
    let clickedOption: string | null = null;
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.getAttribute('role') === 'option') clickedOption = target.textContent;
    });

    await fillForm(
      document,
      [field({ id: 'f1', selector: '#f1', elementRole: 'combobox', options: ['Yes', 'No'] })],
      { f1: 'Yes' },
    );

    expect(clickedOption).toBe('Yes');
  });

  it('does not throw when a combobox option never renders, and continues filling other fields', async () => {
    document.body.innerHTML = `
      <input id="f1" role="combobox" />
      <input id="f2" type="text" />
    `;

    await expect(
      fillForm(
        document,
        [
          field({ id: 'f1', selector: '#f1', elementRole: 'combobox', options: ['Yes'] }),
          field({ id: 'f2', selector: '#f2' }),
        ],
        { f1: 'Yes', f2: 'filled' },
      ),
    ).resolves.not.toThrow();

    expect(document.querySelector<HTMLInputElement>('#f2')!.value).toBe('filled');
  });
});

describe('resolveField', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it("resolves a field's selector to its matching DOM element", () => {
    document.body.innerHTML = `<input id="f1" type="text" />`;

    const el = resolveField(document, field({ id: 'f1', selector: '#f1' }));

    expect(el).toBe(document.querySelector('#f1'));
  });

  it('returns null when the selector matches nothing', () => {
    document.body.innerHTML = '';

    const el = resolveField(document, field({ id: 'f1', selector: '#does-not-exist' }));

    expect(el).toBeNull();
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

  it('also dispatches a dragenter/dragover/drop sequence at the ancestor dropzone wrapper, plus change on the input itself', () => {
    document.body.innerHTML = `<div class="dropzone"><input type="file" id="resume" /></div>`;
    const input = document.querySelector<HTMLInputElement>('#resume')!;
    const dropzone = document.querySelector('.dropzone')!;
    const inputEvents: string[] = [];
    const dropzoneEvents: string[] = [];
    input.addEventListener('change', () => inputEvents.push('change'));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      dropzone.addEventListener(type, () => dropzoneEvents.push(type));
    }
    const file = new File(['%PDF-1.4 ...'], 'resume.pdf', { type: 'application/pdf' });

    attachResumeFile(input, file);

    expect(dropzoneEvents).toEqual(['dragenter', 'dragover', 'drop']);
    expect(inputEvents).toEqual(['change']);
  });

  it('dispatches the drag/drop sequence on the input itself when no dropzone-styled ancestor exists', () => {
    document.body.innerHTML = `<input type="file" id="resume" />`;
    const input = document.querySelector<HTMLInputElement>('#resume')!;
    const inputEvents: string[] = [];
    for (const type of ['dragenter', 'dragover', 'drop', 'change']) {
      input.addEventListener(type, () => inputEvents.push(type));
    }
    const file = new File(['%PDF-1.4 ...'], 'resume.pdf', { type: 'application/pdf' });

    attachResumeFile(input, file);

    expect(inputEvents).toEqual(['dragenter', 'dragover', 'drop', 'change']);
  });
});
