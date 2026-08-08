import { afterEach, describe, expect, it } from 'vitest';
import { isJobApplicationPage } from './detect';

describe('isJobApplicationPage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true when the page has a form with a resume file upload input', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="first_name" />
        <input type="file" name="resume" />
      </form>
    `;

    expect(isJobApplicationPage(document)).toBe(true);
  });

  it('returns false when the page has no form', () => {
    document.body.innerHTML = `<main><h1>About Acme</h1><p>We build things.</p></main>`;

    expect(isJobApplicationPage(document)).toBe(false);
  });

  it('returns false when the page has a form but no file upload input', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="q" />
        <button type="submit">Search</button>
      </form>
    `;

    expect(isJobApplicationPage(document)).toBe(false);
  });
});
