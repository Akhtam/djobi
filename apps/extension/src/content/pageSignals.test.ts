/**
 * Direct coverage of `pageSignals.ts`'s primitives, one function at a time.
 *
 * Every function here is already exercised incidentally by `detectFields.test.ts` and
 * `fillForm.test.ts`'s full-page fixtures, but incidentally is not the same as pinned: several of
 * these fix a real historical bug (the Ashby label-path regression `wrappingFieldLabel` documents,
 * the cross-realm `instanceof` failure `isInstanceOf` documents), and a fixture that happens to
 * still pass after a regression is not the same as a test that names the regression and fails on
 * it. This file is that name, one function at a time — the fixtures stay as the end-to-end proof
 * that the module composes correctly on a real page.
 */
import { describe, expect, it } from 'vitest';
import {
  associatedLabels,
  collapseWhitespace,
  fieldWrappers,
  getSignal,
  isFormControl,
  isInstanceOf,
  isRequiredProxy,
  labelText,
  resolveIdRefs,
} from './pageSignals';

describe('isInstanceOf / isFormControl', () => {
  it('recognizes an input, a textarea and a select as form controls', () => {
    document.body.innerHTML = `<input id="i" /><textarea id="t"></textarea><select id="s"></select><button id="b"></button><div id="d"></div>`;
    expect(isFormControl(document.getElementById('i')!)).toBe(true);
    expect(isFormControl(document.getElementById('t')!)).toBe(true);
    expect(isFormControl(document.getElementById('s')!)).toBe(true);
    expect(isFormControl(document.getElementById('b')!)).toBe(false);
    expect(isFormControl(document.getElementById('d')!)).toBe(false);
  });

  it('recognizes a form control from another document realm, where a bare instanceof reads false', () => {
    // The whole reason this module resolves the constructor off `el.ownerDocument.defaultView`
    // rather than off this realm's global: an iframe's elements are instances of a *different*
    // window's `HTMLInputElement`, so `el instanceof HTMLInputElement` (this realm's) is false for
    // every one of them.
    document.body.innerHTML = `<iframe></iframe>`;
    const inner = document.querySelector('iframe')!.contentDocument!;
    inner.body.innerHTML = `<input id="email" />`;
    const el = inner.getElementById('email')!;

    expect(el instanceof HTMLInputElement).toBe(false);
    expect(isInstanceOf(el, 'HTMLInputElement')).toBe(true);
    expect(isFormControl(el)).toBe(true);
  });

  it('reads false rather than throwing for an element whose document has no window, such as one built with DOMImplementation', () => {
    const detached = document.implementation.createHTMLDocument('').createElement('input');
    expect(detached.ownerDocument.defaultView).toBeNull();
    expect(isInstanceOf(detached, 'HTMLInputElement')).toBe(false);
  });
});

describe('collapseWhitespace', () => {
  it('folds runs of whitespace, including newlines, into single spaces and trims the ends', () => {
    expect(collapseWhitespace('  Are you legally\n      authorized to work  ')).toBe(
      'Are you legally authorized to work',
    );
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(collapseWhitespace('   \n\t  ')).toBe('');
  });
});

describe('labelText', () => {
  it('reads a plain label verbatim, collapsed', () => {
    document.body.innerHTML = `<label id="l">  Country  </label>`;
    expect(labelText(document.getElementById('l')!)).toBe('Country');
  });

  it("excludes a nested control's own text, so a pre-filled wrap-style label doesn't read its value as part of the label", () => {
    // Lever wraps a `<select>` inside its own `<label>`. The select's selected option contributes
    // its text to the label's `textContent`, so a pre-filled field's label used to read
    // "Country United States" and stop matching anything.
    document.body.innerHTML = `
      <label id="l">Country
        <select><option value="us" selected>United States</option></select>
      </label>
    `;
    expect(labelText(document.getElementById('l')!)).toBe('Country');
  });

  it('excludes a nested button as well as a nested field control', () => {
    document.body.innerHTML = `<label id="l">Location <button type="button">Clear</button></label>`;
    expect(labelText(document.getElementById('l')!)).toBe('Location');
  });
});

describe('associatedLabels', () => {
  it("reads every label a native control's own .labels reports, in document order", () => {
    document.body.innerHTML = `
      <label for="q">Question</label>
      <input id="q" />
      <label for="q">(required)</label>
    `;
    const labels = associatedLabels(document, document.getElementById('q')!);
    expect(labels.map((label) => label.textContent)).toEqual(['Question', '(required)']);
  });

  it('finds every label[for] pointing at a non-form-control ARIA widget, not just the first', () => {
    // `associatedLabels` falls back to a hand-rolled `for=` lookup only for elements with no
    // `.labels` — a `role="combobox"` div among them. The lookup reads the attribute rather than
    // `doc.querySelector`, which would have returned only the first match.
    document.body.innerHTML = `
      <label for="w">Team</label>
      <label for="w">Choose one</label>
      <div id="w" role="combobox"></div>
    `;
    const labels = associatedLabels(document, document.getElementById('w')!);
    expect(labels.map((label) => label.textContent)).toEqual(['Team', 'Choose one']);
  });

  it('falls back to a wrapping label for an ARIA widget with no id and no explicit label', () => {
    document.body.innerHTML = `<label>Team <div role="combobox"></div></label>`;
    const widget = document.querySelector('[role="combobox"]')!;
    const labels = associatedLabels(document, widget);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.textContent).toContain('Team');
  });

  it('returns no labels for an unassociated ARIA widget', () => {
    document.body.innerHTML = `<div role="combobox" id="w"></div>`;
    expect(associatedLabels(document, document.getElementById('w')!)).toEqual([]);
  });
});

describe('resolveIdRefs', () => {
  it('concatenates the text of every referenced id, in the order listed', () => {
    document.body.innerHTML = `<span id="a">Are you</span><span id="b">legally authorized</span>`;
    expect(resolveIdRefs(document, 'a b')).toBe('Are you legally authorized');
  });

  it('drops a reference that resolves to nothing rather than leaving a gap', () => {
    document.body.innerHTML = `<span id="a">Are you</span>`;
    expect(resolveIdRefs(document, 'a missing')).toBe('Are you');
  });

  it('returns an empty string when every reference is missing', () => {
    expect(resolveIdRefs(document, 'missing-1 missing-2')).toBe('');
  });
});

describe('isRequiredProxy', () => {
  it("recognizes react-select's hidden required mirror input", () => {
    document.body.innerHTML = `<input aria-hidden="true" required tabindex="-1" style="opacity:0" />`;
    expect(isRequiredProxy(document.querySelector('input')!)).toBe(true);
  });

  it('does not treat an ordinary hidden field, or a visible one, as a proxy', () => {
    document.body.innerHTML = `<input id="visible" /><div aria-hidden="true" id="not-a-control"></div>`;
    expect(isRequiredProxy(document.getElementById('visible')!)).toBe(false);
    expect(isRequiredProxy(document.getElementById('not-a-control')!)).toBe(false);
  });
});

describe('fieldWrappers / getSignal — the Ashby field-path regression', () => {
  it("finds the wrapper's label when a for= points at a field path rather than the input's id", () => {
    // Ashby's `for` names the field path (`_systemfield_location`), which the input's own id never
    // matches — every `for`-, wrapper- and ARIA-based lookup misses, and the search used to fall
    // through to the placeholder ("Start typing…" on every Ashby combobox), sending that text to
    // the answer-drafting model as the question. This is that exact shape.
    document.body.innerHTML = `
      <div class="field-wrapper">
        <label for="_systemfield_location">Where are you currently located?</label>
        <div role="combobox" placeholder="Start typing…"></div>
      </div>
    `;
    const widget = document.querySelector('[role="combobox"]')!;

    expect(associatedLabels(document, widget)).toEqual([]);
    expect(getSignal(document, widget)).toBe('Where are you currently located?');
  });

  it("stops ascending once past the first ancestor holding more than one real control, so a neighbor's label isn't attributed to this field", () => {
    document.body.innerHTML = `
      <div class="form-section">
        <label>First name</label>
        <div class="field-wrapper"><div role="combobox" id="widget"></div></div>
        <label>Last name</label>
        <input />
      </div>
    `;
    const wrappers = Array.from(fieldWrappers(document, document.getElementById('widget')!));
    expect(wrappers.map((el) => el.className)).toEqual(['field-wrapper']);
  });

  it("doesn't let a react-select required-proxy input count as a second control that stops the ascent", () => {
    document.body.innerHTML = `
      <label>Team
        <div class="widget-wrapper">
          <div role="combobox" id="widget"></div>
          <input aria-hidden="true" required tabindex="-1" style="opacity:0" />
        </div>
      </label>
    `;
    expect(getSignal(document, document.getElementById('widget')!)).toBe('Team');
  });
});

describe('getSignal — the fallback ladder', () => {
  it('prefers an associated label over every later fallback', () => {
    document.body.innerHTML = `<label for="f">Real label</label><input id="f" aria-label="ignored" title="ignored" placeholder="ignored" name="ignored" />`;
    expect(getSignal(document, document.getElementById('f')!)).toBe('Real label');
  });

  it('falls back to aria-labelledby, then aria-label, when there is no associated label', () => {
    document.body.innerHTML = `<span id="ref">Referenced text</span><input id="f" aria-labelledby="ref" aria-label="ignored" />`;
    expect(getSignal(document, document.getElementById('f')!)).toBe('Referenced text');

    document.body.innerHTML = `<input id="g" aria-label="Aria label" title="ignored" />`;
    expect(getSignal(document, document.getElementById('g')!)).toBe('Aria label');
  });

  it('falls back through title, then placeholder, then name, in HTML-AAM order', () => {
    document.body.innerHTML = `<input id="f" title="Title text" placeholder="ignored" name="ignored" />`;
    expect(getSignal(document, document.getElementById('f')!)).toBe('Title text');

    document.body.innerHTML = `<input id="g" placeholder="Placeholder text" name="ignored" />`;
    expect(getSignal(document, document.getElementById('g')!)).toBe('Placeholder text');

    document.body.innerHTML = `<input id="h" name="fallback_name" />`;
    expect(getSignal(document, document.getElementById('h')!)).toBe('fallback_name');
  });

  it('falls back to an authored id as a last resort', () => {
    document.body.innerHTML = `<input id="work-authorization" />`;
    expect(getSignal(document, document.getElementById('work-authorization')!)).toBe(
      'work-authorization',
    );
  });

  it("refuses a framework-generated id — react-select's, Radix's, and React's own useId — rather than handing it to the model as the question", () => {
    document.body.innerHTML = `
      <input id="react-select-3-input" />
      <input id=":r1:" />
      <input id="radix-:r2:-trigger" />
    `;
    for (const id of ['react-select-3-input', ':r1:', 'radix-:r2:-trigger']) {
      expect(getSignal(document, document.getElementById(id)!)).toBe('');
    }
  });

  it('returns an empty string when nothing on the ladder resolves', () => {
    document.body.innerHTML = `<input />`;
    expect(getSignal(document, document.querySelector('input')!)).toBe('');
  });
});
