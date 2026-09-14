import { afterEach, describe, expect, it, vi } from 'vitest';
import { armSubmitWatch } from './submitWatch';

describe('armSubmitWatch', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reports a native form submission', () => {
    document.body.innerHTML = `<form id="apply"><button type="submit">Submit</button></form>`;
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reports a submit button that lives outside any <form>, as embedded ATS widgets render', () => {
    document.body.innerHTML = `<div><button type="button">Submit application</button></div>`;
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    document.querySelector('button')!.click();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reports a click that lands on an icon nested inside the submit button', () => {
    document.body.innerHTML = `<button type="button" aria-label="Submit application"><span id="icon">→</span></button>`;
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    document.getElementById('icon')!.click();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    stop();
  });

  it('still sees a submission whose own handler stops the event, since it listens in the capture phase', () => {
    document.body.innerHTML = `<form><button type="submit">Submit</button></form>`;
    const form = document.querySelector('form')!;
    form.addEventListener('submit', (event) => event.stopPropagation());
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    form.dispatchEvent(new Event('submit', { bubbles: true }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reports once when a submit click and the submit event it causes both arrive', () => {
    document.body.innerHTML = `<form><button type="submit">Submit</button></form>`;
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    document.querySelector('button')!.click();
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores a wizard's Next button — a page of a multi-step form is not a submission", () => {
    document.body.innerHTML = `
      <div>
        <button type="button">Back</button>
        <button type="button">Save and continue</button>
        <button type="button">Next</button>
        <button type="button">Upload resume</button>
      </div>
    `;
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    for (const button of document.querySelectorAll('button')) button.click();

    expect(onSubmit).not.toHaveBeenCalled();
    stop();
  });

  it('ignores a disabled submit button, which cannot have submitted anything', () => {
    document.body.innerHTML = `<button type="button" disabled>Submit application</button>`;
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    document.querySelector('button')!.click();

    expect(onSubmit).not.toHaveBeenCalled();
    stop();
  });

  // The accessible way to block a submit button is `aria-disabled`, which — unlike the `disabled`
  // attribute — leaves the browser dispatching the click. An ATS puts it on its real
  // `<button type="submit">` while required fields are still empty, which is precisely the state a
  // djobi fill can leave a form in, so this click must not be reported as a submission.
  it('ignores an aria-disabled native submit button, whose click the browser still dispatches', () => {
    document.body.innerHTML = `<button type="submit" aria-disabled="true">Submit application</button>`;
    const onSubmit = vi.fn();
    const stop = armSubmitWatch(document, onSubmit);

    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onSubmit).not.toHaveBeenCalled();
    stop();
  });

  it('reports nothing after it is stopped, so a re-fill cannot leave an old run reporting', () => {
    document.body.innerHTML = `<form><button type="submit">Submit</button></form>`;
    const onSubmit = vi.fn();

    armSubmitWatch(document, onSubmit)();
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('never interferes with the submission it is watching', () => {
    document.body.innerHTML = `<form><button type="submit">Submit</button></form>`;
    const stop = armSubmitWatch(document, vi.fn());

    const event = new Event('submit', { bubbles: true, cancelable: true });
    document.querySelector('form')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    stop();
  });
});
