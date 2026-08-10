import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from './messages';

describe('sendMessage', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() } });
  });

  it('sends the message via chrome.runtime.sendMessage and resolves with the callback response', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((_message, callback) => {
      (callback as (response: unknown) => void)({ data: { pageText: 'hello', fields: [] } });
    });

    const result = await sendMessage({ type: 'GET_JOB_PAGE_DATA', tabId: 1 });

    expect(result).toEqual({ data: { pageText: 'hello', fields: [] } });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'GET_JOB_PAGE_DATA', tabId: 1 },
      expect.any(Function),
    );
  });
});
