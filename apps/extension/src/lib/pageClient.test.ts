import type { DetectedField } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chromePageClient } from './pageClient';

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
  const sendMessage = vi.fn(
    (_tabId: number, _message: unknown, callback: (response?: unknown) => void) => callback(reply),
  );
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

  it('resolves null when no frame answers, rather than hanging or rejecting', async () => {
    stubTabs(undefined);

    await expect(chromePageClient.scan(7)).resolves.toBeNull();
  });

  it('reads runtime.lastError so an unanswered scan is not an unchecked runtime error', async () => {
    const { readLastError } = stubTabs(undefined);

    await chromePageClient.scan(7);

    expect(readLastError).toHaveBeenCalled();
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

    await chromePageClient.fill(7, { fields: [], values: { 'f-email': 'jane@example.com' } });

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      {
        type: 'FILL_FORM',
        fields: [],
        values: { 'f-email': 'jane@example.com' },
        resumeFile: undefined,
      },
      expect.any(Function),
    );
  });

  it("resolves null when no frame answers — which the caller must not read as 'nothing was filled'", async () => {
    stubTabs(undefined);

    await expect(chromePageClient.fill(7, { fields: [], values: {} })).resolves.toBeNull();
  });
});
