/**
 * Detection and filling against a **real, unmodified Lever application form**, captured live.
 *
 * `__fixtures__/sonarsource-lever.html` is the `<form id="application-form">` element served by
 * `jobs.lever.co/sonarsource/e503ad3d-13bc-4e9c-a141-228df320e010/apply`, verbatim — only the page
 * chrome around it (600KB of inline stylesheet and analytics script that jsdom would parse on every
 * run) was dropped. Nothing inside the form was touched.
 *
 * This file exists because that posting was reported as filling nothing at all, and there was no
 * repro for it: `PROGRESS.md` recorded a second non-autofilling form that had never been supplied,
 * so the suspicion could not be tested. The fixture settles the detection half of the question —
 * every field on this form is found and classified correctly, and the values written into them
 * stick. The failure was in the extension's frame plumbing instead (see `lib/pageClient.ts`), which
 * is covered by `lib/pageClient.test.ts` and `content/index.test.ts`.
 *
 * Lever's markup is a different shape from Greenhouse's in three ways worth pinning down: labels
 * associate by *wrapping* rather than `for=`, required-ness is marked with U+2731 (`✱`) inside the
 * label rather than an asterisk or a `required` attribute alone, and custom questions are named
 * `cards[<uuid>][fieldN]` with no id of any kind.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DetectedField } from '@djobi/shared';
import { detectFields } from './detectFields';
import { fillForm } from './fillForm';

/** Resolved against this file, not the working directory — see `greenhouseForm.test.ts` on why. */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');
}

/**
 * The fixture loaded into this test's own document, so `ownerDocument.defaultView` exists — without
 * a browsing context `detectFields` reports no required flags and no select options, and this file
 * would look like it passed while testing the wrong thing.
 */
function detect(): DetectedField[] {
  document.body.innerHTML = fixture('sonarsource-lever.html');
  return detectFields(document);
}

/** The one field whose label contains `needle`; throws rather than silently asserting on nothing. */
function find(fields: DetectedField[], needle: string): DetectedField {
  const matches = fields.filter((field) =>
    field.label.toLowerCase().includes(needle.toLowerCase()),
  );
  if (matches.length !== 1) {
    throw new Error(`${matches.length} fields' labels contain ${JSON.stringify(needle)}, wanted 1`);
  }
  return matches[0]!;
}

describe('a live Lever application form', () => {
  it('is recognized as a job application page at all', async () => {
    const { isJobApplicationPage } = await import('./detect');
    document.body.innerHTML = fixture('sonarsource-lever.html');

    expect(isJobApplicationPage(document)).toBe(true);
  });

  it('finds the contact fields and maps each onto the profile value that fills it', () => {
    const fields = detect();

    // Wrap-style labels: none of these inputs carries an id, a placeholder or a `for=` label.
    expect(find(fields, 'Full name')).toMatchObject({ category: 'full_name', required: true });
    expect(find(fields, 'Email')).toMatchObject({ category: 'email', required: true });
    expect(find(fields, 'Phone')).toMatchObject({ category: 'phone', required: true });
    expect(find(fields, 'Current location')).toMatchObject({ category: 'location' });
    expect(find(fields, 'LinkedIn')).toMatchObject({ category: 'linkedin_url', required: true });
  });

  it('reads the U+2731 marker in a wrapping label as required', () => {
    const fields = detect();

    // Lever marks required with `<span class="required">✱</span>` inside the label. The `name`,
    // `email`, `phone` and `location` inputs also carry a native `required`, but the LinkedIn one
    // is where the two part company on this form — and an optional-looking required field is how a
    // submission gets rejected for something the panel reported as filled.
    expect(find(fields, 'LinkedIn').required).toBe(true);
    // Not everything is required: the company field carries neither signal.
    expect(find(fields, 'Current company').required).toBe(false);
  });

  it('finds the resume upload, so the Fill Step knows to render a tailored PDF', () => {
    const fields = detect();
    const uploads = fields.filter((field) => field.category === 'resume_upload');

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.inputType).toBe('file');
  });

  it("classifies the posting's custom questions as questions, not as unknown fields", () => {
    const fields = detect();
    // `cards[<uuid>][fieldN]` — no id, no placeholder, and the label is a wrapping div.
    const questions = fields.filter(
      (field) => field.category === 'question' && field.selector.startsWith('[data-djobi-id='),
    );

    expect(questions.length).toBeGreaterThan(0);
    // A `<select>` question carries its choices, so an answer can be matched onto the form's own
    // wording rather than written as free text into something that only accepts an option.
    const withOptions = questions.filter((field) => (field.options?.length ?? 0) > 0);
    expect(withOptions.length).toBeGreaterThan(0);
  });

  it('groups the demographic-survey radios into one field per question, not one per choice', () => {
    const fields = detect();
    // Six age-band radios sharing `surveysResponses[…][responses][field0]`. Ungrouped they arrive as
    // six `unknown` fields labelled "18-20", "21-29"… — each unanswerable on its own.
    const ageBand = fields.filter((field) =>
      field.options?.some((option) => option.label === '60 or older'),
    );

    expect(ageBand).toHaveLength(1);
    expect(ageBand[0]!.options).toHaveLength(6);
  });

  it('writes values into the form and verifies the page kept them', async () => {
    const fields = detect();
    const values = {
      [find(fields, 'Full name').id]: 'Jane Doe',
      [find(fields, 'Email').id]: 'jane@example.com',
      [find(fields, 'LinkedIn').id]: 'https://linkedin.com/in/janedoe',
    };

    const filled = await fillForm(document, fields, values, { settleMs: 0 });

    expect(filled.sort()).toEqual(Object.keys(values).sort());
    expect(document.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Jane Doe');
    expect(document.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe(
      'jane@example.com',
    );
    expect(document.querySelector<HTMLInputElement>('input[name="urls[LinkedIn]"]')!.value).toBe(
      'https://linkedin.com/in/janedoe',
    );
  });
});
