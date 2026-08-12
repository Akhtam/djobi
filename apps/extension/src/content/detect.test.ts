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

  it("returns true for a file upload input with no wrapping <form>, as embedded ATS widgets (e.g. Ashby on a company's own domain) often render", () => {
    document.body.innerHTML = `<div id="ashby_embed"><input type="file" name="resume" /></div>`;

    expect(isJobApplicationPage(document)).toBe(true);
  });

  it('returns true for an application whose upload control is a button, not an input — a labelled LinkedIn/resume field is enough', () => {
    document.body.innerHTML = `
      <div>
        <button type="button">Upload resume</button>
        <label for="linkedin">LinkedIn URL</label>
        <input id="linkedin" type="text" />
      </div>
    `;

    expect(isJobApplicationPage(document)).toBe(true);
  });

  it("doesn't mistake a job posting that merely talks about resumes for the application form itself", () => {
    document.body.innerHTML = `
      <main>
        <h1>Senior Engineer</h1>
        <p>Send us your resume and a cover letter, and add your LinkedIn.</p>
        <label for="q">Search jobs</label>
        <input id="q" type="text" />
      </main>
    `;

    expect(isJobApplicationPage(document)).toBe(false);
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
    history.pushState({}, '', '/');
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

  it("keeps reporting as the form changes, so a form that mounts in pieces isn't captured half-built", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<input type="file" name="resume" />`;
    const onDetected = vi.fn();

    const stop = watchForJobApplicationPage(document, onDetected);
    expect(onDetected).toHaveBeenCalledTimes(1);

    document.body.innerHTML += `<input type="text" name="email" />`;
    await vi.advanceTimersByTimeAsync(500);

    expect(onDetected).toHaveBeenCalledTimes(2);
    stop();
  });

  it('coalesces a burst of changes into one report, rather than one per mutation', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<input type="file" name="resume" />`;
    const onDetected = vi.fn();

    const stop = watchForJobApplicationPage(document, onDetected, { settleMs: 500 });
    onDetected.mockClear();

    document.body.innerHTML += `<input type="text" name="a" />`;
    await vi.advanceTimersByTimeAsync(200);
    document.body.innerHTML += `<input type="text" name="b" />`;
    await vi.advanceTimersByTimeAsync(200);
    document.body.innerHTML += `<input type="text" name="c" />`;
    await vi.advanceTimersByTimeAsync(500);

    expect(onDetected).toHaveBeenCalledTimes(1);
    stop();
  });

  it("re-arms after a client-side route change, so a form the page routes to after the arming window elapsed is still found (Ashby's posting -> /application pushState)", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><h1>Senior Engineer</h1></main>`;
    const onDetected = vi.fn();

    const stop = watchForJobApplicationPage(document, onDetected, {
      timeoutMs: 1000,
      urlPollMs: 1000,
    });

    // The arming window elapses on the posting page, which has no form.
    await vi.advanceTimersByTimeAsync(2000);
    expect(onDetected).not.toHaveBeenCalled();

    history.pushState({}, '', '/acme/job-id/application');
    await vi.advanceTimersByTimeAsync(1000);
    document.body.innerHTML = `<main><input type="file" name="resume" /></main>`;
    await vi.advanceTimersByTimeAsync(100);

    expect(onDetected).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stop() also cancels the route-change poll', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><h1>Careers</h1></main>`;
    const onDetected = vi.fn();

    const stop = watchForJobApplicationPage(document, onDetected, { timeoutMs: 1000 });
    stop();

    history.pushState({}, '', '/acme/job-id/application');
    document.body.innerHTML = `<main><input type="file" name="resume" /></main>`;
    await vi.advanceTimersByTimeAsync(5000);

    expect(onDetected).not.toHaveBeenCalled();
  });
});
