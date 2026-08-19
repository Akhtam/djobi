import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScrapeJobDescriptionResponse } from './messages';
import { readPostingFromTab } from './postingReader';

function stubChrome(
  frames: number[],
  responses: Record<number, ScrapeJobDescriptionResponse | undefined>,
) {
  const sendMessage = vi.fn(
    (
      _tabId: number,
      _message: unknown,
      options: { frameId: number },
      callback: (response?: ScrapeJobDescriptionResponse) => void,
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

describe('readPostingFromTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('addresses every frame and selects the highest-scoring result rather than the first reply', async () => {
    const sendMessage = stubChrome([0, 4], {
      0: { candidate: { text: 'Top frame', score: 50, source: 'dom' } },
      4: { candidate: { text: 'Embedded posting', score: 90, source: 'structured-data' } },
    });

    await expect(readPostingFromTab(7)).resolves.toEqual({
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
    stubChrome([3, 0], {
      0: { candidate: { text: 'Top frame', score: 70, source: 'dom' } },
      3: { candidate: { text: 'Iframe', score: 70, source: 'dom' } },
    });

    await expect(readPostingFromTab(7)).resolves.toMatchObject({
      status: 'success',
      candidate: { text: 'Top frame' },
    });
  });

  it('distinguishes a reachable page with no confident posting from unreachable content scripts', async () => {
    stubChrome([0], { 0: { candidate: null } });
    await expect(readPostingFromTab(7)).resolves.toEqual({ status: 'not-found' });

    stubChrome([0], { 0: undefined });
    await expect(readPostingFromTab(7)).resolves.toEqual({ status: 'unavailable' });
  });

  it('reinjects the manifest content script and retries when an open tab predates the extension build', async () => {
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
        _details: chrome.scripting.ScriptInjection,
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

    await expect(readPostingFromTab(7)).resolves.toEqual({ status: 'success', candidate });
    expect(executeScript).toHaveBeenCalledWith(
      {
        target: { tabId: 7, allFrames: true },
        files: ['content.js'],
      },
      expect.any(Function),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
