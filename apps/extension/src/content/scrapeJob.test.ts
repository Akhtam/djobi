import { afterEach, describe, expect, it } from 'vitest';
import { scrapePageText } from './scrapeJob';

describe('scrapePageText', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('prefers <main> content over surrounding nav/footer text', () => {
    document.body.innerHTML = `
      <nav>Home Jobs About</nav>
      <main>Senior Engineer at Acme. We need someone with 5+ years of React.</main>
      <footer>© Acme 2026</footer>
    `;

    const text = scrapePageText(document);

    expect(text).toBe('Senior Engineer at Acme. We need someone with 5+ years of React.');
  });

  it('falls back to [role="main"] when there is no <main> tag', () => {
    document.body.innerHTML = `
      <nav>Home Jobs About</nav>
      <div role="main">Staff Engineer at Beta Corp.</div>
    `;

    expect(scrapePageText(document)).toBe('Staff Engineer at Beta Corp.');
  });

  it('falls back to the full body text when neither <main> nor [role="main"] exist', () => {
    document.body.innerHTML = `<div>Just a plain div with the job text.</div>`;

    expect(scrapePageText(document)).toBe('Just a plain div with the job text.');
  });
});
