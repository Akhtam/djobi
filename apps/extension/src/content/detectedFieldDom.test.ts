/**
 * The **detect→fill crossing**: every case here runs the real {@link detectFields} and then resolves
 * against the same document, which is the one thing neither module's own suite does.
 *
 * `fillForm.test.ts` hand-builds its Detected Fields with a `field()` factory and never calls
 * `detectFields`, so a rule the two halves disagree about is invisible to it — both halves can be
 * green while the pair is broken. Until this file, the only tests exercising both were the two
 * captured-fixture suites, which run whole real postings and cannot isolate a single rule.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DetectedField } from '@djobi/shared';
import { detectFields } from './detectFields';
import { resolveChoice } from './detectedFieldDom';
import { fillForm } from './fillForm';

afterEach(() => {
  document.body.innerHTML = '';
});

/** The one detected field whose label contains `needle`; throws rather than asserting on nothing. */
function fieldFor(fields: DetectedField[], needle: string): DetectedField {
  const matches = fields.filter((field) =>
    field.label.toLowerCase().includes(needle.toLowerCase()),
  );
  if (matches.length !== 1) {
    throw new Error(`${matches.length} fields' labels contain ${JSON.stringify(needle)}, wanted 1`);
  }
  return matches[0];
}

/** Scans `document` and resolves `answer` on the field named by `needle`, in one step. */
function crossing(needle: string, answer: string) {
  return resolveChoice(document, fieldFor(detectFields(document), needle), answer);
}

describe('resolving a drafted answer back onto the page it was detected from', () => {
  it('finds the radio a native choice group named', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Are you authorized to work in the US?</legend>
        <label><input type="radio" name="auth" value="y" /> Yes</label>
        <label><input type="radio" name="auth" value="n" /> No</label>
      </fieldset>
    `;

    const choice = crossing('authorized', 'No');

    expect(choice.ok).toBe(true);
    expect(choice.ok && (choice.element as HTMLInputElement).value).toBe('n');
  });

  it("finds the button an ARIA radiogroup named, which is how Ashby renders a group's answers", () => {
    document.body.innerHTML = `
      <div>
        <div id="q">Do you require visa sponsorship?</div>
        <div role="radiogroup" aria-labelledby="q">
          <button role="radio" aria-checked="false" data-v="yes">Yes</button>
          <button role="radio" aria-checked="false" data-v="no">No</button>
        </div>
      </div>
    `;

    const choice = crossing('sponsorship', 'Yes');

    expect(choice.ok).toBe(true);
    expect(choice.ok && choice.element.getAttribute('data-v')).toBe('yes');
  });

  it("finds a <select>'s option, whose choices its grammar of radios and ARIA stand-ins can't see", () => {
    document.body.innerHTML = `
      <label for="team">Which team are you applying to?</label>
      <select id="team">
        <option value="">Select…</option>
        <option value="plat">Platform</option>
        <option value="growth">Growth</option>
      </select>
    `;

    const choice = crossing('team', 'Growth');

    expect(choice.ok).toBe(true);
    expect(choice.ok && (choice.element as HTMLOptionElement).value).toBe('growth');
  });

  it('falls back to label text for a choice that had no element to record at detection time', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Preferred start date</legend>
        <label><input type="radio" name="start" value="now" /> Immediately</label>
        <label><input type="radio" name="start" value="later" /> In two months</label>
      </fieldset>
    `;
    const field = fieldFor(detectFields(document), 'start date');
    // The shape `parseDetectedFields` produces for an option known only from an ATS API schema, or
    // from a listbox that mounts on open: a label with nothing to click recorded against it.
    const unrecorded: DetectedField = {
      ...field,
      options: field.options?.map((option) => ({ ...option, selector: null })),
    };

    const choice = resolveChoice(document, unrecorded, 'In two months');

    expect(choice.ok).toBe(true);
    expect(choice.ok && (choice.element as HTMLInputElement).value).toBe('later');
  });

  it('clicks within the answering group when another group on the page reuses its choice ids', () => {
    // Duplicate ids are real ATS markup, not a contrivance — both captured Greenhouse postings ship
    // `id="accepted-filetypes"` twice. `detectFields`' tagger prefers a page-supplied `id` over
    // minting a `data-djobi-id`, so a recorded option selector is `#yes` here, and resolving that
    // document-wide returns the *first* match: the wrong question's radio. The click landed there,
    // and the verifier — which re-reads the element it just clicked — reported it filled.
    document.body.innerHTML = `
      <fieldset>
        <legend>Have you worked here before?</legend>
        <label><input id="yes" type="radio" name="prior" value="prior-yes" /> Yes</label>
        <label><input id="no" type="radio" name="prior" value="prior-no" /> No</label>
      </fieldset>
      <fieldset>
        <legend>Do you need sponsorship?</legend>
        <label><input id="yes" type="radio" name="visa" value="visa-yes" /> Yes</label>
        <label><input id="no" type="radio" name="visa" value="visa-no" /> No</label>
      </fieldset>
    `;

    const choice = crossing('sponsorship', 'Yes');

    expect(choice.ok).toBe(true);
    expect(choice.ok && (choice.element as HTMLInputElement).value).toBe('visa-yes');
  });

  it('takes the native input when a group renders an ARIA proxy beside it under the same label', () => {
    // The two halves used to grade this differently. Detection prefers native inputs and falls back
    // to ARIA only when there are none; the Fill Step hand-concatenated both selector lists into one
    // literal and queried them together — so it saw two choices labelled "Yes", matched neither, and
    // left the field blank.
    document.body.innerHTML = `
      <fieldset>
        <legend>Are you over 18?</legend>
        <label><input type="radio" name="age" value="native-yes" /> Yes</label>
        <div role="radio" aria-checked="false" aria-label="Yes" data-proxy="yes"></div>
      </fieldset>
    `;
    const field = fieldFor(detectFields(document), 'over 18');
    // Detection recorded exactly one "Yes", so drop the recorded selector to force the label scan —
    // which is the path that read the two lists differently.
    const unrecorded: DetectedField = {
      ...field,
      options: field.options?.map((option) => ({ ...option, selector: null })),
    };

    const choice = resolveChoice(document, unrecorded, 'Yes');

    expect(choice.ok).toBe(true);
    expect(choice.ok && (choice.element as HTMLInputElement).value).toBe('native-yes');
  });

  it('resolves in a document from another realm, which detection has always promised and filling did not', () => {
    // `detectFields` documents and tests that an `iframe.contentDocument` is safe to pass. Every
    // DOM-class test on the filling side was a bare `instanceof` against this realm's constructors,
    // so the identical `(doc: Document)` parameter quietly meant something narrower there.
    document.body.innerHTML = `<iframe></iframe>`;
    const inner = document.querySelector('iframe')!.contentDocument!;
    inner.body.innerHTML = `
      <fieldset>
        <legend>Can you work on-site?</legend>
        <label><input type="radio" name="site" value="y" /> Yes</label>
        <label><input type="radio" name="site" value="n" /> No</label>
      </fieldset>
    `;
    const field = fieldFor(detectFields(inner), 'on-site');

    const choice = resolveChoice(inner, field, 'No');

    expect(choice.ok).toBe(true);
    expect(choice.ok && (choice.element as HTMLInputElement).value).toBe('n');
  });

  it('fills a form in another realm end to end, where every bare instanceof silently read false', async () => {
    // The resolution half was always realm-safe. The filling half was not: `isChosen` fell through
    // to the ARIA branch for a native radio and reported a good fill as unfilled, and the `<select>`
    // branch missed entirely, so a select was driven as if it were a text input. Both only show up
    // in the round trip, which is why this asserts through `fillForm` rather than `resolveChoice`.
    document.body.innerHTML = `<iframe></iframe>`;
    const inner = document.querySelector('iframe')!.contentDocument!;
    inner.body.innerHTML = `
      <fieldset>
        <legend>Can you work on-site?</legend>
        <label><input type="radio" name="site" value="y" /> Yes</label>
        <label><input type="radio" name="site" value="n" /> No</label>
      </fieldset>
      <label for="team">Which team are you applying to?</label>
      <select id="team">
        <option value="">Select…</option>
        <option value="plat">Platform</option>
      </select>
    `;
    const fields = detectFields(inner);
    const group = fieldFor(fields, 'on-site');
    const select = fieldFor(fields, 'team');

    const filled = await fillForm(
      inner,
      fields,
      { [group.id]: 'No', [select.id]: 'Platform' },
      { settleMs: 0 },
    );

    expect(new Set(filled)).toEqual(new Set([group.id, select.id]));
    expect(inner.querySelector<HTMLInputElement>('input[value="n"]')!.checked).toBe(true);
    expect(inner.querySelector<HTMLSelectElement>('#team')!.value).toBe('plat');
  });

  it('refuses an answer the field gives two meanings rather than picking one', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Which offices work for you?</legend>
        <label><input type="checkbox" name="office" value="ny1" /> New York</label>
        <label><input type="checkbox" name="office" value="ny2" /> New York</label>
      </fieldset>
    `;

    const choice = crossing('offices', 'New York');

    expect(choice).toEqual({ ok: false, reason: 'ambiguous-answer' });
  });

  it('reports a field the page no longer has as missing, not as an answer that named no choice', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Are you authorized to work in the US?</legend>
        <label><input type="radio" name="auth" value="y" /> Yes</label>
      </fieldset>
    `;
    const field = fieldFor(detectFields(document), 'authorized');
    document.body.innerHTML = '';

    expect(resolveChoice(document, field, 'Yes')).toEqual({ ok: false, reason: 'field-missing' });
  });
});
