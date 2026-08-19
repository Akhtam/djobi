import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('content script', () => {
  let loaded: { stopReporting: () => void } | null = null;

  /**
   * Imports the content script fresh, and remembers it so `afterEach` can stop it watching. The
   * module is a singleton over the one shared jsdom `document`: an instance left running goes on
   * observing that document and reporting into the *next* test's `chrome` stub.
   */
  async function loadContentScript() {
    loaded = await import('./index');
    return loaded;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    loaded?.stopReporting();
    loaded = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reports the detected fields via REPORT_JOB_PAGE when the page is a job application page', async () => {
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

    await loadContentScript();

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'REPORT_JOB_PAGE',
        fields: expect.arrayContaining([expect.objectContaining({ category: 'email' })]),
      }),
    );
  });

  it('does not report anything when the page is not a job application page', async () => {
    document.body.innerHTML = `<main><h1>About Acme</h1></main>`;
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });

    await loadContentScript();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('answers an explicit scrape request with the focused Job Description', async () => {
    document.body.innerHTML = `
      <main>
        <article class="job-description">
          <h1>Senior Engineer</h1>
          <h2>About the role</h2>
          <p>Acme builds reliable infrastructure for engineering organizations around the world. This role partners closely with product and customer teams to solve important operational problems.</p>
          <h2>What you'll bring</h2>
          <p>You have extensive TypeScript experience and have operated distributed systems in production.</p>
        </article>
      </main>
    `;
    let listener!: (
      message: { type: string },
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn((registered) => (listener = registered)) },
      },
    });
    await loadContentScript();
    const sendResponse = vi.fn();

    expect(listener({ type: 'SCRAPE_JOB_DESCRIPTION' }, {}, sendResponse)).toBe(true);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        candidate: expect.objectContaining({
          source: 'dom',
          text: expect.stringContaining("What you'll bring"),
        }),
      }),
    );
  });

  it("reports the job page once an ATS embed widget (e.g. Ashby on a company's own domain) renders its form in asynchronously", async () => {
    document.body.innerHTML = `<main><h1>Careers at Acme</h1><div id="ashby_embed"></div></main>`;
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });

    await loadContentScript();
    expect(sendMessage).not.toHaveBeenCalled();

    document.querySelector('#ashby_embed')!.innerHTML = `<input type="file" name="resume" />`;

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'REPORT_JOB_PAGE' }),
      ),
    );
  });

  it("re-reports when the form changes after the first detection, so a form that mounted in pieces isn't left half-detected", async () => {
    document.body.innerHTML = `<main><form><input type="file" name="resume" /></form></main>`;
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });

    await loadContentScript();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    document.querySelector('form')!.innerHTML += `
      <label for="email-field">Email</label>
      <input id="email-field" type="text" />
    `;

    await vi.waitFor(
      () =>
        expect(sendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            fields: expect.arrayContaining([expect.objectContaining({ category: 'email' })]),
          }),
        ),
      { timeout: 2000 },
    );
  });

  it("doesn't re-report an unchanged page — every report invalidates that frame's in-flight API enrichment", async () => {
    document.body.innerHTML = `<main><form><input type="file" name="resume" /></form></main>`;
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });

    await loadContentScript();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // A re-render that changes no field and no text — the shape of the DOM churn a React ATS form
    // produces constantly while the candidate is looking at it.
    document.querySelector('form')!.appendChild(document.createElement('span'));
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('stops reporting when the extension has been reloaded out from under it, instead of failing silently forever', async () => {
    document.body.innerHTML = `<main><form><input type="file" name="resume" /></form></main>`;
    const sendMessage = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });

    await loadContentScript();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphaned'), expect.any(Error));

    document.querySelector('form')!.innerHTML += `<input id="email-field" type="text" />`;
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('answers SCAN_PAGE with a fresh scan of the page as it stands now', async () => {
    document.body.innerHTML = `<main><form><input type="file" name="resume" /></form></main>`;
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

    await loadContentScript();
    // Mounted *after* the page was first reported — exactly what the Fill Step would otherwise miss.
    document.querySelector('form')!.innerHTML += `
      <label for="email-field">Email</label>
      <input id="email-field" type="text" />
    `;

    const sendResponse = vi.fn();
    listener({ type: 'SCAN_PAGE' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.arrayContaining([expect.objectContaining({ category: 'email' })]),
      }),
    );
  });

  it("answers SCAN_PAGE with the fields it can find even on a page the detection heuristic doesn't recognize, since the user picked this tab and asked it to fill", async () => {
    // No file input and no resume/LinkedIn-labelled field: `isJobApplicationPage` says no.
    document.body.innerHTML = `
      <main><form>
        <label for="email-field">Email</label>
        <input id="email-field" type="text" />
      </form></main>
    `;
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

    await loadContentScript();
    const sendResponse = vi.fn();
    listener({ type: 'SCAN_PAGE' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.arrayContaining([expect.objectContaining({ category: 'email' })]),
      }),
    );
  });

  it('stays silent on SCAN_PAGE in a frame with no fields, so the reply comes from the frame that has them', async () => {
    document.body.innerHTML = `<main><h1>Careers at Acme</h1></main>`;
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

    await loadContentScript();
    const sendResponse = vi.fn();

    expect(listener({ type: 'SCAN_PAGE' }, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('stays silent on FILL_FORM in a frame holding none of the fields, so the real frame is the one that answers', async () => {
    // A third-party iframe — an invisible hCaptcha, a tag-manager pixel — gets its own copy of this
    // content script, resolves none of the fields, and used to answer `filledFieldIds: []`
    // immediately. `chrome.tabs.sendMessage` resolves with whichever frame replies first, and this
    // one always beat the frame that actually owns the form, since that one waits out `fillForm`'s
    // verification settle. The Fill Step then reported "nothing filled" for a form it had just
    // filled correctly.
    document.body.innerHTML = `<main><h1>hCaptcha challenge</h1></main>`;
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

    await loadContentScript();
    const sendResponse = vi.fn();

    expect(
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
              required: false,
              elementRole: 'native',
            },
          ],
          values: { f1: 'jane@example.com' },
        },
        {},
        sendResponse,
      ),
      // `false`, not `true`: no async reply is coming, so the message channel must not be held open.
    ).toBe(false);
    // Given a moment in case a reply were on its way — the point is that none ever is.
    await Promise.resolve();
    expect(sendResponse).not.toHaveBeenCalled();
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

    await loadContentScript();
    const sendResponse = vi.fn();
    expect(
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
              required: false,
              elementRole: 'native',
            },
          ],
          values: { f1: 'jane@example.com' },
        },
        {},
        sendResponse,
      ),
    ).toBe(true);
    // `fillForm` verifies what it wrote after letting the page settle, so the reply is a timer
    // away rather than a microtask away — see `content/fillForm.ts`.
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(document.querySelector<HTMLInputElement>('#email-field')!.value).toBe(
      'jane@example.com',
    );
    // The field verified as still holding its value, so it's reported filled.
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      filledFieldIds: ['f1'],
      resumeAttached: false,
    });
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

    await loadContentScript();
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
            required: false,
            elementRole: 'native',
          },
        ],
        values: {},
        resumeFile: { name: 'resume.pdf', type: 'application/pdf', bytes: [37, 80, 68, 70] },
      },
      {},
      vi.fn(),
    );
    await Promise.resolve();
    await Promise.resolve();

    const input = document.querySelector<HTMLInputElement>('#resume-field')!;
    expect(input.files).toHaveLength(1);
    const attached = input.files?.[0];
    expect(attached?.name).toBe('resume.pdf');
    expect(attached?.type).toBe('application/pdf');
    expect(attached?.size).toBe(4);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsArrayBuffer(attached!);
    });
    expect(Array.from(new Uint8Array(bytes))).toEqual([37, 80, 68, 70]);
  });

  it("attaches the resume to the required resume_upload field when more than one is detected (e.g. Ashby's extra unlabeled, non-required file input)", async () => {
    document.body.innerHTML = `
      <main>
        <input id="decoy-field" type="file" />
        <input id="resume-field" type="file" />
      </main>
    `;
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

    await loadContentScript();
    listener(
      {
        type: 'FILL_FORM',
        fields: [
          {
            id: 'f-decoy',
            label: '',
            inputType: 'file',
            selector: '#decoy-field',
            category: 'resume_upload',
            required: false,
            elementRole: 'native',
          },
          {
            id: 'f-resume',
            label: 'Resume',
            inputType: 'file',
            selector: '#resume-field',
            category: 'resume_upload',
            required: true,
            elementRole: 'native',
          },
        ],
        values: {},
        resumeFile: { name: 'resume.pdf', type: 'application/pdf', bytes: [37, 80, 68, 70] },
      },
      {},
      vi.fn(),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector<HTMLInputElement>('#resume-field')!.files).toHaveLength(1);
    expect(document.querySelector<HTMLInputElement>('#decoy-field')!.files).toHaveLength(0);
  });
});
