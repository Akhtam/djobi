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

/**
 * Timing collapsed to near-nothing. These knobs were module constants until they became
 * {@link FillOptions}, so every test that awaited a fill paid the real 300ms settle, and the
 * "options never arrive" case paid the whole 20 × 50ms poll budget.
 */
const FAST = { settleMs: 0, optionWaitAttempts: 3, optionWaitIntervalMs: 1 };

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

  it("writes through the prototype setter so React's value tracker sees a change and fires onChange", () => {
    // React makes an input controlled by installing an *instance-level* `value` accessor whose
    // setter moves its cached copy in lockstep. A plain `el.value = x` hits that accessor, the
    // cache follows, React's change detector sees cached === current, and no `onChange` is
    // dispatched — the text appears in the DOM but the component's state never learns of it, so
    // the value is wiped on the next render and validation still sees an empty required field.
    // This stands in for that tracker; jsdom alone cannot fail on the bug.
    document.body.innerHTML = `<input id="f1" type="text" />`;
    const input = document.querySelector<HTMLInputElement>('#f1')!;

    let tracked = '';
    const prototypeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => tracked,
      set(next: string) {
        tracked = next;
        prototypeSetter.call(input, next);
      },
    });

    fillForm(document, [field({ id: 'f1', selector: '#f1' })], { f1: 'jane@example.com' });

    // The DOM took the value, but the instance tracker was bypassed — exactly the divergence
    // React's `updateValueIfChanged` looks for before dispatching a change.
    expect(tracked).toBe('');
    expect(
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(input),
    ).toBe('jane@example.com');
  });

  it('blurs each field after writing it, for form libraries that only commit a value on blur', async () => {
    // The reported failure this covers: an ATS submits, and every visibly-filled required field
    // comes back "missing entry". Form libraries layered over React (react-hook-form's `onBlur`
    // mode being the common one) hold the text in local component state and push it into the form
    // model on blur, so a fill that writes and walks away leaves the DOM looking right and the
    // model empty.
    document.body.innerHTML = `<input id="f1" type="text" />`;
    const input = document.querySelector<HTMLInputElement>('#f1')!;
    const seen: string[] = [];
    for (const type of ['focus', 'input', 'change', 'blur', 'focusout']) {
      input.addEventListener(type, () => seen.push(type));
    }

    await fillForm(
      document,
      [field({ id: 'f1', selector: '#f1' })],
      { f1: 'jane@example.com' },
      FAST,
    );

    expect(seen).toEqual(['focus', 'input', 'change', 'blur', 'focusout']);
  });

  it('reports a field as filled only if the page still holds the value once it has re-rendered', async () => {
    // A controlled React field whose `onChange` never fired keeps the text until the next render
    // and is then reverted. Reading back immediately would call that a success, so the check is
    // deferred — this stands in for the revert.
    document.body.innerHTML = `<input id="f1" type="text" /><input id="f2" type="text" />`;
    const reverting = document.querySelector<HTMLInputElement>('#f1')!;
    reverting.addEventListener('input', () => {
      setTimeout(() => {
        reverting.value = '';
      }, 0);
    });

    const filled = await fillForm(
      document,
      [field({ id: 'f1', selector: '#f1' }), field({ id: 'f2', selector: '#f2' })],
      { f1: 'jane@example.com', f2: 'jane@example.com' },
      FAST,
    );

    expect(filled).toEqual(['f2']);
  });

  it('reports nothing filled when the selectors no longer resolve, rather than reporting intent', async () => {
    document.body.innerHTML = `<input id="other" type="text" />`;

    // The stale-selector case: the form re-mounted between detection and fill, so `data-djobi-id`
    // went with it. Nothing is written, and nothing is claimed.
    expect(
      await fillForm(document, [field({ id: 'f1', selector: '#f1' })], { f1: 'x' }, FAST),
    ).toEqual([]);
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

  it("checks the radio the option's recorded selector points at, without re-deriving any label text", () => {
    document.body.innerHTML = `
      <fieldset id="f1">
        <label><input type="radio" id="opt-yes" name="auth" value="yes" />Yes</label>
        <label><input type="radio" id="opt-no" name="auth" value="no" />No</label>
      </fieldset>
    `;

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'radiogroup',
          options: [
            { label: 'Yes', selector: '#opt-yes' },
            { label: 'No', selector: '#opt-no' },
          ],
        }),
      ],
      { f1: 'Yes' },
      FAST,
    );

    expect(document.querySelector<HTMLInputElement>('#opt-yes')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#opt-no')!.checked).toBe(false);
  });

  it("follows the recorded selector even when the option's label no longer matches the DOM text — an ATS API's wording can differ from what the page renders", () => {
    document.body.innerHTML = `
      <fieldset id="f1">
        <label><input type="radio" id="opt-yes" name="auth" />Yes, authorized</label>
        <label><input type="radio" id="opt-no" name="auth" />No, not authorized</label>
      </fieldset>
    `;

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'radiogroup',
          // API wording; the DOM says "Yes, authorized". Text matching alone would find nothing.
          options: [
            { label: 'Authorized to work', selector: '#opt-yes' },
            { label: 'Not authorized', selector: '#opt-no' },
          ],
        }),
      ],
      { f1: 'Authorized to work' },
    );

    expect(document.querySelector<HTMLInputElement>('#opt-yes')!.checked).toBe(true);
  });

  it('fills an option whose own label contains a comma — the value is one choice, never a delimited list', () => {
    document.body.innerHTML = `
      <fieldset id="f1">
        <label><input type="radio" id="opt-sf" name="loc" />San Francisco, CA</label>
        <label><input type="radio" id="opt-ny" name="loc" />New York, NY</label>
      </fieldset>
    `;

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'radiogroup',
          options: [
            { label: 'San Francisco, CA', selector: '#opt-sf' },
            { label: 'New York, NY', selector: '#opt-ny' },
          ],
        }),
      ],
      { f1: 'San Francisco, CA' },
    );

    expect(document.querySelector<HTMLInputElement>('#opt-sf')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#opt-ny')!.checked).toBe(false);
  });

  it("falls back to matching label text for an option with no recorded selector, including a `for=id` sibling label (Ashby's markup)", () => {
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
          options: [
            { label: 'Yes and I am local', selector: null },
            { label: 'No and I am not willing', selector: null },
          ],
        }),
      ],
      { f1: 'Yes and I am local' },
    );

    expect(document.querySelector<HTMLInputElement>('#opt-a')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#opt-b')!.checked).toBe(false);
  });

  it('checks the matching checkbox in a checkboxgroup', () => {
    document.body.innerHTML = `
      <fieldset id="f1">
        <label><input type="checkbox" id="opt-ts" value="ts" />TypeScript</label>
        <label><input type="checkbox" id="opt-py" value="py" />Python</label>
      </fieldset>
    `;

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'checkboxgroup',
          options: [
            { label: 'TypeScript', selector: '#opt-ts' },
            { label: 'Python', selector: '#opt-py' },
          ],
        }),
      ],
      { f1: 'TypeScript' },
    );

    expect(document.querySelector<HTMLInputElement>('#opt-ts')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#opt-py')!.checked).toBe(false);
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
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'combobox',
          // Portal-mounted: nothing existed to tag at detection time, so these carry no selector
          // and the live listbox is matched by label — the one case text matching is unavoidable.
          options: [
            { label: 'Yes', selector: null },
            { label: 'No', selector: null },
          ],
        }),
      ],
      { f1: 'Yes' },
      FAST,
    );

    expect(clickedOption).toBe('Yes');
  });

  it('clicks the combobox option the recorded selector points at when the listbox was already in the DOM at detection time', async () => {
    document.body.innerHTML = `
      <input id="f1" role="combobox" />
      <ul id="listbox" role="listbox" hidden>
        <li role="option" id="opt-yes">Yes</li>
        <li role="option" id="opt-no">No</li>
      </ul>
    `;
    let clickedId: string | null = null;
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.getAttribute('role') === 'option') clickedId = target.id;
    });

    await fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'combobox',
          options: [
            { label: 'Yes', selector: '#opt-yes' },
            { label: 'No', selector: '#opt-no' },
          ],
        }),
      ],
      { f1: 'Yes' },
      FAST,
    );

    expect(clickedId).toBe('opt-yes');
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
          field({
            id: 'f1',
            selector: '#f1',
            elementRole: 'combobox',
            options: [{ label: 'Yes', selector: null }],
          }),
          field({ id: 'f2', selector: '#f2' }),
        ],
        { f1: 'Yes', f2: 'filled' },
        FAST,
      ),
    ).resolves.not.toThrow();

    expect(document.querySelector<HTMLInputElement>('#f2')!.value).toBe('filled');
  });

  it("clicks the ARIA radio the option's recorded selector points at — an Ashby-style group whose choices are buttons, not inputs", () => {
    document.body.innerHTML = `
      <div id="f1" role="radiogroup">
        <button type="button" role="radio" id="opt-yes" aria-checked="false">Yes</button>
        <button type="button" role="radio" id="opt-no" aria-checked="false">No</button>
      </div>
    `;
    const clicked: string[] = [];
    for (const id of ['opt-yes', 'opt-no']) {
      document.querySelector(`#${id}`)!.addEventListener('click', () => clicked.push(id));
    }

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'radiogroup',
          options: [
            { label: 'Yes', selector: '#opt-yes' },
            { label: 'No', selector: '#opt-no' },
          ],
        }),
      ],
      { f1: 'No' },
    );

    expect(clicked).toEqual(['opt-no']);
  });

  it('falls back to matching an ARIA choice by its visible text when the option carries no recorded selector (e.g. it came from the platform API, not the DOM)', () => {
    document.body.innerHTML = `
      <div id="f1" role="radiogroup">
        <button type="button" role="radio" id="opt-yes">Yes</button>
        <button type="button" role="radio" id="opt-no">No</button>
      </div>
    `;
    const clicked: string[] = [];
    for (const id of ['opt-yes', 'opt-no']) {
      document.querySelector(`#${id}`)!.addEventListener('click', () => clicked.push(id));
    }

    fillForm(
      document,
      [
        field({
          id: 'f1',
          selector: '#f1',
          elementRole: 'radiogroup',
          options: [
            { label: 'Yes', selector: null },
            { label: 'No', selector: null },
          ],
        }),
      ],
      { f1: 'yes' },
    );

    expect(clicked).toEqual(['opt-yes']);
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

  it('bubbles the drag/drop sequence up to an ancestor dropzone wrapper, for widgets that only listen there', () => {
    document.body.innerHTML = `<div class="dropzone"><input type="file" id="resume" /></div>`;
    const input = document.querySelector<HTMLInputElement>('#resume')!;
    const dropzone = document.querySelector('.dropzone')!;
    const dropzoneEvents: string[] = [];
    for (const type of ['dragenter', 'dragover', 'drop']) {
      dropzone.addEventListener(type, () => dropzoneEvents.push(type));
    }
    const file = new File(['%PDF-1.4 ...'], 'resume.pdf', { type: 'application/pdf' });

    attachResumeFile(input, file);

    expect(dropzoneEvents).toEqual(['dragenter', 'dragover', 'drop']);
  });

  it('fires change before the drag sequence, so a dropzone sees the real file first', () => {
    document.body.innerHTML = `<input type="file" id="resume" />`;
    const input = document.querySelector<HTMLInputElement>('#resume')!;
    const inputEvents: string[] = [];
    for (const type of ['dragenter', 'dragover', 'drop', 'change']) {
      input.addEventListener(type, () => inputEvents.push(type));
    }
    const file = new File(['%PDF-1.4 ...'], 'resume.pdf', { type: 'application/pdf' });

    attachResumeFile(input, file);

    expect(inputEvents).toEqual(['change', 'dragenter', 'dragover', 'drop']);
  });

  it("exposes the file through the drop event's `dataTransfer.items`, the list react-dropzone reads", () => {
    // Regression: `items` used to be `{ add: () => {} }` — truthy, so react-dropzone's file-selector
    // took its `items` branch, found no `length`, and extracted zero files while ignoring `files`
    // entirely. Ashby's uploader is react-dropzone, so the resume silently never attached.
    document.body.innerHTML = `<input type="file" id="resume" />`;
    const input = document.querySelector<HTMLInputElement>('#resume')!;
    const file = new File(['%PDF-1.4 ...'], 'resume.pdf', { type: 'application/pdf' });
    let dropped: DataTransfer | null = null;
    input.addEventListener('drop', (event) => {
      dropped = (event as DragEvent).dataTransfer;
    });

    attachResumeFile(input, file);

    const items = dropped!.items;
    expect(items).toHaveLength(1);
    expect(Array.from(items as unknown as ArrayLike<DataTransferItem>)[0]!.kind).toBe('file');
  });
});
