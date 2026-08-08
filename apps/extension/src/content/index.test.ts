import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('content script', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reports the scraped job page via REPORT_JOB_PAGE when the page is a job application page', async () => {
    document.body.innerHTML = `
      <main>
        <h1>Senior Engineer at Acme</h1>
        <form>
          <label for="email-field">Email</label>
          <input id="email-field" type="text" />
          <input type="file" name="resume" />
        </form>
      </main>
    `;
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });

    await import('./index');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'REPORT_JOB_PAGE',
        pageText: expect.stringContaining('Senior Engineer at Acme'),
        fields: expect.arrayContaining([expect.objectContaining({ category: 'email' })]),
      }),
    );
  });

  it('does not report anything when the page is not a job application page', async () => {
    document.body.innerHTML = `<main><h1>About Acme</h1></main>`;
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });

    await import('./index');

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('fills the form when it receives a FILL_FORM message', async () => {
    document.body.innerHTML = `<main><input id="email-field" type="text" /></main>`;
    let listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (r: unknown) => void,
    ) => void = () => {};
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
        onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
      },
    });

    await import('./index');
    const sendResponse = vi.fn();
    listener(
      {
        type: 'FILL_FORM',
        fields: [
          {
            id: 'f1',
            label: 'Email',
            inputType: 'text',
            selector: '#email-field',
            category: 'email',
          },
        ],
        values: { f1: 'jane@example.com' },
      },
      {},
      sendResponse,
    );

    expect(document.querySelector<HTMLInputElement>('#email-field')!.value).toBe(
      'jane@example.com',
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('attaches the resume file to the resume_upload field when FILL_FORM includes one', async () => {
    document.body.innerHTML = `<main><input id="resume-field" type="file" /></main>`;
    let listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (r: unknown) => void,
    ) => void = () => {};
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
        onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
      },
    });

    await import('./index');
    listener(
      {
        type: 'FILL_FORM',
        fields: [
          {
            id: 'f1',
            label: 'Resume',
            inputType: 'file',
            selector: '#resume-field',
            category: 'resume_upload',
          },
        ],
        values: {},
        resumeFile: { name: 'resume.pdf', type: 'application/pdf', bytes: [37, 80, 68, 70] },
      },
      {},
      vi.fn(),
    );

    const input = document.querySelector<HTMLInputElement>('#resume-field')!;
    expect(input.files).toHaveLength(1);
    expect(input.files?.[0].name).toBe('resume.pdf');
  });
});
