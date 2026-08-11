import { afterEach, describe, expect, it, vi } from 'vitest';
import { isJobApplicationPage, watchForJobApplicationPage } from './detect';

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

  it('returns true for a file upload input with no wrapping <form>, as embedded ATS widgets (e.g. Ashby on a company\'s own domain) often render', () => {
    document.body.innerHTML = `<div id="ashby_embed"><input type="file" name="resume" /></div>`;

    expect(isJobApplicationPage(document)).toBe(true);
  });

  it('returns false when the page has no file upload input anywhere', () => {
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

describe('watchForJobApplicationPage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('calls onDetected immediately (synchronously) when the page already qualifies', () => {
    document.body.innerHTML = `<input type="file" name="resume" />`;
    const onDetected = vi.fn();

    watchForJobApplicationPage(document, onDetected);

    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it("doesn't call onDetected yet for a page that isn't a job page, but does once a matching element is added later", async () => {
    document.body.innerHTML = `<main><h1>Careers</h1></main>`;
    const onDetected = vi.fn();

    watchForJobApplicationPage(document, onDetected);
    expect(onDetected).not.toHaveBeenCalled();

    document.body.innerHTML += `<input type="file" name="resume" />`;
    await vi.waitFor(() => expect(onDetected).toHaveBeenCalledTimes(1));
  });

  it('gives up quietly and stops observing once the timeout elapses', () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><h1>Careers</h1></main>`;
    const onDetected = vi.fn();

    watchForJobApplicationPage(document, onDetected, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    document.body.innerHTML += `<input type="file" name="resume" />`;
    vi.advanceTimersByTime(1000);

    expect(onDetected).not.toHaveBeenCalled();
  });

  it('the returned stop() function cancels watching early', () => {
    document.body.innerHTML = `<main><h1>Careers</h1></main>`;
    const onDetected = vi.fn();

    const stop = watchForJobApplicationPage(document, onDetected);
    stop();
    document.body.innerHTML += `<input type="file" name="resume" />`;

    expect(onDetected).not.toHaveBeenCalled();
  });
});
