import { afterEach, describe, expect, it } from 'vitest';
import { detectFields } from './detectFields';

describe('detectFields', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('classifies a labeled email input and falls back to unknown for an unmatched field', () => {
    document.body.innerHTML = `
      <form>
        <label for="email-field">Email</label>
        <input id="email-field" type="text" />
        <label for="mystery-field">Referral code</label>
        <input id="mystery-field" type="text" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ label: 'Email', inputType: 'text', category: 'email' });
    expect(fields[1]).toMatchObject({
      label: 'Referral code',
      inputType: 'text',
      category: 'unknown',
    });
  });

  it('assigns each field a selector that actually resolves back to that element, even without a native id', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="a" />
        <div><input type="text" name="b" /></div>
        <input type="text" name="c" />
      </form>
    `;

    const fields = detectFields(document);

    fields.forEach((field, index) => {
      const resolved = document.querySelector(field.selector);
      expect(resolved).not.toBeNull();
      expect(resolved?.getAttribute('name')).toBe(['a', 'b', 'c'][index]);
    });
  });

  it('classifies file inputs as resume_upload or cover_letter_upload based on their label', () => {
    document.body.innerHTML = `
      <form>
        <label for="resume-field">Resume/CV</label>
        <input id="resume-field" type="file" />
        <label for="cover-field">Cover Letter</label>
        <input id="cover-field" type="file" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0]).toMatchObject({ category: 'resume_upload' });
    expect(fields[1]).toMatchObject({ category: 'cover_letter_upload' });
  });

  it('classifies a long-form textarea with a question-shaped label as a question, but not a plain unmatched textarea', () => {
    document.body.innerHTML = `
      <form>
        <label for="why-field">Why do you want to work here?</label>
        <textarea id="why-field"></textarea>
        <label for="notes-field">Additional notes</label>
        <textarea id="notes-field"></textarea>
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0]).toMatchObject({ category: 'question' });
    expect(fields[1]).toMatchObject({ category: 'unknown' });
  });

  it('classifies the remaining scalar categories by their label keywords', () => {
    document.body.innerHTML = `
      <form>
        <label for="f1">First Name</label><input id="f1" type="text" />
        <label for="f2">Last Name</label><input id="f2" type="text" />
        <label for="f3">Full Name</label><input id="f3" type="text" />
        <label for="f4">Phone Number</label><input id="f4" type="tel" />
        <label for="f5">Location</label><input id="f5" type="text" />
        <label for="f6">LinkedIn URL</label><input id="f6" type="text" />
        <label for="f7">Portfolio/Website</label><input id="f7" type="text" />
        <label for="f8">GitHub</label><input id="f8" type="text" />
        <label for="f9">Cover Letter</label><textarea id="f9"></textarea>
      </form>
    `;

    const categories = detectFields(document).map((field) => field.category);

    expect(categories).toEqual([
      'first_name',
      'last_name',
      'full_name',
      'phone',
      'location',
      'linkedin_url',
      'portfolio_url',
      'github_url',
      'cover_letter_text',
    ]);
  });

  it('skips hidden inputs and buttons, which carry no candidate data', () => {
    document.body.innerHTML = `
      <form>
        <input type="hidden" name="csrf" value="abc" />
        <label for="email-field">Email</label>
        <input id="email-field" type="text" />
        <button type="submit">Apply</button>
        <input type="button" value="Cancel" />
        <input type="reset" value="Reset" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ category: 'email' });
  });
});
