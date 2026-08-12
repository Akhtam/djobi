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

  it("builds a resolvable selector even when the element's id contains CSS-special characters (e.g. Greenhouse's `question_123[]` multi-value ids)", () => {
    document.body.innerHTML = `
      <form>
        <label for="question_68209436[]">Referral source</label>
        <input id="question_68209436[]" type="text" />
      </form>
    `;

    const fields = detectFields(document);

    expect(() => document.querySelector(fields[0].selector)).not.toThrow();
    expect(document.querySelector(fields[0].selector)).toBe(
      document.getElementById('question_68209436[]'),
    );
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

  it('flags a field required via the native attribute, aria-required, or a nearby required-styled marker', () => {
    document.body.innerHTML = `
      <form>
        <label for="native-required">Email</label>
        <input id="native-required" type="text" required />
        <label for="aria-required-field">Phone</label>
        <input id="aria-required-field" type="text" aria-required="true" />
        <label for="marked-field">Full Name<span class="required">*</span></label>
        <input id="marked-field" type="text" />
        <label for="optional-field">Referral code</label>
        <input id="optional-field" type="text" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields.map((field) => field.required)).toEqual([true, true, true, false]);
  });

  it('resolves a label that wraps its input with no `for` attribute', () => {
    document.body.innerHTML = `
      <form>
        <label><div class="application-label">Full name</div><input type="text" name="name" /></label>
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0]).toMatchObject({ label: 'Full name', category: 'full_name' });
  });

  it('resolves a label referenced via aria-labelledby', () => {
    document.body.innerHTML = `
      <form>
        <div id="email-label">Email</div>
        <input type="text" aria-labelledby="email-label" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0]).toMatchObject({ label: 'Email', category: 'email' });
  });

  it('detects a role=combobox widget, resolving its options from an in-DOM (possibly hidden) listbox via aria-controls', () => {
    document.body.innerHTML = `
      <form>
        <div id="work-auth-label">Are you authorized to work in the US?</div>
        <input role="combobox" aria-labelledby="work-auth-label" aria-controls="work-auth-listbox" aria-required="true" />
        <ul id="work-auth-listbox" role="listbox" hidden>
          <li role="option">Yes</li>
          <li role="option">No</li>
        </ul>
      </form>
    `;

    const fields = detectFields(document);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      label: 'Are you authorized to work in the US?',
      category: 'question',
      elementRole: 'combobox',
      required: true,
    });
    expect(fields[0].options?.map((option) => option.label)).toEqual(['Yes', 'No']);
    // Each choice keeps a selector back to its own element, so the Fill Step never re-derives text.
    expect(
      fields[0].options?.map((option) => document.querySelector(option.selector!)?.textContent),
    ).toEqual(['Yes', 'No']);
  });

  it('still detects a role=combobox widget whose aria-controls target is not in the DOM yet, without options', () => {
    document.body.innerHTML = `
      <form>
        <div id="sponsor-label">Will you require sponsorship?</div>
        <input role="combobox" aria-labelledby="sponsor-label" aria-controls="portal-listbox-1" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      label: 'Will you require sponsorship?',
      category: 'question',
      elementRole: 'combobox',
    });
    expect(fields[0].options).toBeUndefined();
  });

  it("resolves each radio/checkbox option's real label text via `for=id` even when the label doesn't wrap the input (e.g. Ashby's markup), instead of falling back to the input's default \"on\" value", () => {
    document.body.innerHTML = `
      <form>
        <fieldset>
          <legend>Are you willing to come into the office?</legend>
          <span><input type="radio" id="opt-a" name="office" /></span>
          <label for="opt-a">Yes, I am local</label>
          <span><input type="radio" id="opt-b" name="office" /></span>
          <label for="opt-b">No, I am not willing</label>
        </fieldset>
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0].options?.map((option) => option.label)).toEqual([
      'Yes, I am local',
      'No, I am not willing',
    ]);
    expect(
      fields[0].options?.map((option) => document.querySelector(option.selector!)?.id),
    ).toEqual(['opt-a', 'opt-b']);
  });

  it('classifies "Legal Name" (a common full-name synonym) as full_name, not unknown', () => {
    document.body.innerHTML = `
      <form>
        <label for="legal-name">Legal Name</label>
        <input id="legal-name" type="text" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0]).toMatchObject({ category: 'full_name' });
  });

  it('classifies a bare "Name" as full_name — Ashby labels its single required name field exactly that', () => {
    document.body.innerHTML = `
      <form>
        <label for="name">Name <span class="required">*</span></label>
        <input id="name" type="text" required />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0]).toMatchObject({ category: 'full_name', required: true });
  });

  it('does not mistake a label that merely contains "name" for the candidate\'s own name', () => {
    document.body.innerHTML = `
      <form>
        <label for="employer">Name of your current employer</label>
        <input id="employer" type="text" />
        <label for="preferred">Preferred name</label>
        <input id="preferred" type="text" />
      </form>
    `;

    const fields = detectFields(document);

    expect(fields.map((f) => f.category)).toEqual(['unknown', 'unknown']);
  });

  it('groups a fieldset of checkboxes into one field instead of reporting each checkbox separately', () => {
    document.body.innerHTML = `
      <form>
        <fieldset aria-required="true">
          <legend>Which languages do you know?<span class="required">*</span></legend>
          <label><input type="checkbox" value="ts" />TypeScript</label>
          <label><input type="checkbox" value="py" />Python</label>
          <label><input type="checkbox" value="go" />Go</label>
        </fieldset>
      </form>
    `;

    const fields = detectFields(document);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      label: 'Which languages do you know?*',
      category: 'question',
      elementRole: 'checkboxgroup',
      required: true,
    });
    expect(fields[0].options?.map((option) => option.label)).toEqual([
      'TypeScript',
      'Python',
      'Go',
    ]);
    expect(
      fields[0].options?.map(
        (option) => document.querySelector<HTMLInputElement>(option.selector!)?.value,
      ),
    ).toEqual(['ts', 'py', 'go']);
  });

  it("reports a native select's choices, which previously went undetected entirely — leaving a select-backed question with nothing to choose from", () => {
    document.body.innerHTML = `
      <form>
        <label for="tz">What time zone are you in?</label>
        <select id="tz">
          <option value="">Select…</option>
          <option value="pt">Pacific Time</option>
          <option value="et">Eastern Time</option>
        </select>
      </form>
    `;

    const fields = detectFields(document);

    expect(fields[0].options?.map((option) => option.label)).toEqual([
      'Pacific Time',
      'Eastern Time',
    ]);
    expect(
      fields[0].options?.map(
        (option) => document.querySelector<HTMLOptionElement>(option.selector!)?.value,
      ),
    ).toEqual(['pt', 'et']);
  });
});
