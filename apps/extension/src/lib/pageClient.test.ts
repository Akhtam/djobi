import type { DetectedField } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScrapeJobDescriptionResponse } from './messages';
import { chromePageClient, PageResponseError } from './pageClient';

/**
 * These rules used to live inline in `background/applicationPipeline.ts`'s default deps, where the
 * only way to reach them was to run a whole Analysis or Fill Step. Both are the kind of thing that
 * fails silently when wrong: an unread `lastError` is a console warning nobody sees, and an
 * `ArrayBuffer` on the wire arrives as `{}` rather than throwing.
 */

const resumeField: DetectedField = {
  id: 'f-resume',
  label: 'Resume',
  inputType: 'file',
  selector: '#resume',
  category: 'resume_upload',
  required: true,
  elementRole: 'native',
};

/** Stubs `chrome.tabs.sendMessage`, replying with `reply` (or not at all when it's `undefined`). */
function stubTabs(reply?: unknown) {
  // The callback is the last argument, since an optional `{ frameId }` bag may sit before it.
  const sendMessage = vi.fn((_tabId: number, _message: unknown, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (response?: unknown) => void;
    return callback(reply);
  });
  const readLastError = vi.fn(() => undefined);
  vi.stubGlobal('chrome', { tabs: { sendMessage }, runtime: {} });
  Object.defineProperty(chrome.runtime, 'lastError', { get: readLastError, configurable: true });
  return { sendMessage, readLastError };
}

describe('chromePageClient.scan', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("resolves with the frame's reply", async () => {
    const { sendMessage } = stubTabs({ fields: [resumeField] });

    await expect(chromePageClient.scan(7)).resolves.toEqual({ fields: [resumeField] });
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'SCAN_PAGE' }, expect.any(Function));
  });

  it('addresses the frame holding the form when one is known, instead of broadcasting to the tab', async () => {
    // Without `{ frameId }` the runtime delivers to every frame and resolves with whichever answers
    // first. The content script runs in all of them, third-party iframes included, so on a page
    // carrying an invisible hCaptcha the wrong frame's empty answer wins the race.
    const { sendMessage } = stubTabs({ fields: [resumeField] });

    await chromePageClient.scan(7, 3);

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { type: 'SCAN_PAGE' },
      { frameId: 3 },
      expect.any(Function),
    );
  });

  it('broadcasts when no frame has reported yet, since there is nobody to address', async () => {
    const { sendMessage } = stubTabs({ fields: [resumeField] });

    await chromePageClient.scan(7);

    // Three arguments, not four — `{ frameId: undefined }` is not the same message to the runtime.
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'SCAN_PAGE' }, expect.any(Function));
  });

  it('resolves null when no frame answers, rather than hanging or rejecting', async () => {
    stubTabs(undefined);

    await expect(chromePageClient.scan(7)).resolves.toBeNull();
  });

  it('reads runtime.lastError so an unanswered scan is not an unchecked runtime error', async () => {
    const { readLastError } = stubTabs(undefined);

    await chromePageClient.scan(7);

    expect(readLastError).toHaveBeenCalled();
  });

  it('rejects a malformed scan reply at the content-script boundary', async () => {
    stubTabs({ fields: 'not-an-array' });

    await expect(chromePageClient.scan(7)).rejects.toMatchObject({
      name: 'PageResponseError',
      command: 'SCAN_PAGE',
    } satisfies Partial<PageResponseError>);
  });
});

describe('chromePageClient.fill', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('encodes the resume as a plain number[], since the runtime cannot carry an ArrayBuffer', async () => {
    const { sendMessage } = stubTabs({
      ok: true,
      filledFieldIds: ['f-resume'],
      resumeAttached: true,
    });

    await chromePageClient.fill(7, {
      runId: 'run-1',
      fields: [resumeField],
      values: {},
      resume: {
        name: 'jane_doe_resume.pdf',
        type: 'application/pdf',
        bytes: new Uint8Array([37, 80, 68, 70]).buffer,
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      {
        type: 'FILL_FORM',
        runId: 'run-1',
        fields: [resumeField],
        values: {},
        resumeFile: {
          name: 'jane_doe_resume.pdf',
          type: 'application/pdf',
          bytes: [37, 80, 68, 70],
        },
      },
      expect.any(Function),
    );
  });

  it('omits resumeFile entirely when there is no resume to attach', async () => {
    const { sendMessage } = stubTabs({ ok: true, filledFieldIds: [], resumeAttached: false });

    await chromePageClient.fill(7, {
      runId: 'run-1',
      fields: [],
      values: { 'f-email': 'jane@example.com' },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      {
        type: 'FILL_FORM',
        runId: 'run-1',
        fields: [],
        values: { 'f-email': 'jane@example.com' },
        resumeFile: undefined,
      },
      expect.any(Function),
    );
  });

  it('addresses the frame holding the form when one is known', async () => {
    const { sendMessage } = stubTabs({ ok: true, filledFieldIds: [], resumeAttached: false });

    await chromePageClient.fill(7, { runId: 'run-1', fields: [], values: {} }, 3);

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'FILL_FORM' }),
      { frameId: 3 },
      expect.any(Function),
    );
  });

  it("resolves null when no frame answers — which the caller must not read as 'nothing was filled'", async () => {
    stubTabs(undefined);

    await expect(
      chromePageClient.fill(7, { runId: 'run-1', fields: [], values: {} }),
    ).resolves.toBeNull();
  });

  it('never reinjects and retries a fill that may already have clicked or uploaded', async () => {
    stubTabs(undefined);
    const executeScript = vi.fn();
    Object.assign(chrome, { scripting: { executeScript } });

    await chromePageClient.fill(7, { runId: 'run-1', fields: [], values: {} });

    expect(executeScript).not.toHaveBeenCalled();
  });

  it('rejects a malformed fill reply at the content-script boundary', async () => {
    stubTabs({ ok: true, filledFieldIds: 'not-an-array', resumeAttached: false });

    await expect(
      chromePageClient.fill(7, { runId: 'run-1', fields: [], values: {} }),
    ).rejects.toMatchObject({
      name: 'PageResponseError',
      command: 'FILL_FORM',
    } satisfies Partial<PageResponseError>);
  });

  it.each([
    [{ ok: false, filledFieldIds: [], resumeAttached: false }, {}, 'ok'],
    [
      { ok: true, filledFieldIds: ['not-requested'], resumeAttached: false },
      {},
      'unrequested field',
    ],
    [{ ok: true, filledFieldIds: [], resumeAttached: true }, {}, 'no resume was sent'],
  ])('rejects a contradictory fill reply: %s', async (reply, values, detail) => {
    stubTabs(reply);

    await expect(
      chromePageClient.fill(7, { runId: 'run-1', fields: [], values }),
    ).rejects.toMatchObject({
      name: 'PageResponseError',
      command: 'FILL_FORM',
      message: expect.stringContaining(detail),
    } satisfies Partial<PageResponseError>);
  });

  it("rejects a requested field that wasn't actually given a value", async () => {
    stubTabs({ ok: true, filledFieldIds: [resumeField.id], resumeAttached: false });

    await expect(
      chromePageClient.fill(7, { runId: 'run-1', fields: [resumeField], values: {} }),
    ).rejects.toMatchObject({
      name: 'PageResponseError',
      message: expect.stringContaining('unrequested field'),
    } satisfies Partial<PageResponseError>);
  });
});

function stubPostingChrome(frames: number[], responses: Record<number, unknown>) {
  const sendMessage = vi.fn(
    (
      _tabId: number,
      _message: unknown,
      options: { frameId: number },
      callback: (response?: unknown) => void,
    ) => callback(responses[options.frameId]),
  );
  vi.stubGlobal('chrome', {
    webNavigation: {
      getAllFrames: vi.fn((_details: unknown, callback: (result: { frameId: number }[]) => void) =>
        callback(frames.map((frameId) => ({ frameId }))),
      ),
    },
    tabs: { sendMessage },
    runtime: { lastError: undefined },
  });
  return sendMessage;
}

describe('chromePageClient.readPosting', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('addresses every frame and selects the highest-scoring result rather than the first reply', async () => {
    const sendMessage = stubPostingChrome([0, 4], {
      0: { candidate: { text: 'Top frame', score: 50, source: 'dom' } },
      4: { candidate: { text: 'Embedded posting', score: 90, source: 'structured-data' } },
    });

    await expect(chromePageClient.readPosting(7)).resolves.toEqual({
      status: 'success',
      candidate: { text: 'Embedded posting', score: 90, source: 'structured-data' },
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { type: 'SCRAPE_JOB_DESCRIPTION' },
      { frameId: 4 },
      expect.any(Function),
    );
  });

  it('prefers the top frame when scores tie', async () => {
    stubPostingChrome([3, 0], {
      0: { candidate: { text: 'Top frame', score: 70, source: 'dom' } },
      3: { candidate: { text: 'Iframe', score: 70, source: 'dom' } },
    });

    await expect(chromePageClient.readPosting(7)).resolves.toMatchObject({
      status: 'success',
      candidate: { text: 'Top frame' },
    });
  });

  it('distinguishes a reachable page with no posting from unreachable content scripts', async () => {
    stubPostingChrome([0], { 0: { candidate: null } });
    await expect(chromePageClient.readPosting(7)).resolves.toEqual({ status: 'not-found' });

    stubPostingChrome([0], { 0: undefined });
    await expect(chromePageClient.readPosting(7)).resolves.toEqual({ status: 'unavailable' });
  });

  it('keeps a valid candidate when another frame returns a malformed response', async () => {
    stubPostingChrome([0, 4], {
      0: { candidate: { text: 'Valid posting', score: 50, source: 'dom' } },
      4: { candidate: { text: 42, score: 'high', source: 'dom' } },
    });

    await expect(chromePageClient.readPosting(7)).resolves.toMatchObject({
      status: 'success',
      candidate: { text: 'Valid posting' },
    });
  });

  it('rejects malformed scrape replies when no frame returns a valid response', async () => {
    stubPostingChrome([0, 4], {
      0: { candidate: { text: 42, score: 50, source: 'dom' } },
      4: undefined,
    });

    await expect(chromePageClient.readPosting(7)).rejects.toMatchObject({
      name: 'PageResponseError',
      command: 'SCRAPE_JOB_DESCRIPTION',
    } satisfies Partial<PageResponseError>);
  });

  it('reinjects and retries only when every frame is unreachable', async () => {
    let reconnected = false;
    const candidate = { text: 'Anthropic job description', score: 90, source: 'dom' as const };
    const sendMessage = vi.fn(
      (
        _tabId: number,
        _message: unknown,
        _options: { frameId: number },
        callback: (response?: ScrapeJobDescriptionResponse) => void,
      ) => callback(reconnected ? { candidate } : undefined),
    );
    const executeScript = vi.fn(
      (
        _details: chrome.scripting.ScriptInjection<unknown[], unknown>,
        callback: (results: chrome.scripting.InjectionResult[]) => void,
      ) => {
        reconnected = true;
        callback([]);
      },
    );
    vi.stubGlobal('chrome', {
      webNavigation: {
        getAllFrames: vi.fn(
          (_details: unknown, callback: (result: { frameId: number }[]) => void) =>
            callback([{ frameId: 0 }]),
        ),
      },
      tabs: { sendMessage },
      scripting: { executeScript },
      runtime: {
        lastError: undefined,
        getManifest: () => ({
          content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }],
        }),
      },
    });

    await expect(chromePageClient.readPosting(7)).resolves.toEqual({
      status: 'success',
      candidate,
    });
    expect(executeScript).toHaveBeenCalledWith(
      { target: { tabId: 7, allFrames: true }, files: ['content.js'] },
      expect.any(Function),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  /**
   * A frame answering with an unexpected shape is most often a *stale* content script — an orphan
   * left by an extension reload — which is the case reinjection exists to repair. Throwing at the
   * first sweep pre-empted that repair and told the candidate to reload the tab instead.
   */
  it('reinjects for a malformed reply too, since a stale content script answers with one', async () => {
    let reconnected = false;
    const candidate = { text: 'Anthropic job description', score: 90, source: 'dom' as const };
    const sendMessage = vi.fn(
      (
        _tabId: number,
        _message: unknown,
        _options: { frameId: number },
        callback: (response?: unknown) => void,
      ) => callback(reconnected ? { candidate } : { candidate: { text: 42, score: 'high' } }),
    );
    const executeScript = vi.fn(
      (
        _details: chrome.scripting.ScriptInjection<unknown[], unknown>,
        callback: (results: chrome.scripting.InjectionResult[]) => void,
      ) => {
        reconnected = true;
        callback([]);
      },
    );
    vi.stubGlobal('chrome', {
      webNavigation: {
        getAllFrames: vi.fn(
          (_details: unknown, callback: (result: { frameId: number }[]) => void) =>
            callback([{ frameId: 0 }]),
        ),
      },
      tabs: { sendMessage },
      scripting: { executeScript },
      runtime: {
        lastError: undefined,
        getManifest: () => ({
          content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }],
        }),
      },
    });

    await expect(chromePageClient.readPosting(7)).resolves.toEqual({
      status: 'success',
      candidate,
    });
    expect(executeScript).toHaveBeenCalledOnce();
  });

  it('still raises the malformed reply when reinjection does not fix it', async () => {
    // Reachable frames that disagree with this build\'s contract are more informative than a bare
    // "unavailable": the fix is a rebuild, not a tab reload.
    const executeScript = vi.fn(
      (
        _details: chrome.scripting.ScriptInjection<unknown[], unknown>,
        callback: (results: chrome.scripting.InjectionResult[]) => void,
      ) => callback([]),
    );
    const sendMessage = vi.fn(
      (
        _tabId: number,
        _message: unknown,
        _options: { frameId: number },
        callback: (response?: unknown) => void,
      ) => callback({ candidate: { text: 42, score: 'high' } }),
    );
    vi.stubGlobal('chrome', {
      webNavigation: {
        getAllFrames: vi.fn(
          (_details: unknown, callback: (result: { frameId: number }[]) => void) =>
            callback([{ frameId: 0 }]),
        ),
      },
      tabs: { sendMessage },
      scripting: { executeScript },
      runtime: {
        lastError: undefined,
        getManifest: () => ({
          content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }],
        }),
      },
    });

    await expect(chromePageClient.readPosting(7)).rejects.toMatchObject({
      name: 'PageResponseError',
      command: 'SCRAPE_JOB_DESCRIPTION',
    } satisfies Partial<PageResponseError>);
    expect(executeScript).toHaveBeenCalledOnce();
  });
});
