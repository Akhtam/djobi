import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToBackground } from './sendToBackground';

describe('sendToBackground', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() } });
  });

  it('sends { path, body } via chrome.runtime.sendMessage and resolves with the response data', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((_message, callback) => {
      (callback as (response: unknown) => void)({ data: { fullName: 'Jane Doe' } });
    });

    const result = await sendToBackground('/profile', undefined);

    expect(result).toEqual({ fullName: 'Jane Doe' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { path: '/profile', body: undefined },
      expect.any(Function),
    );
  });

  it('rejects with the relayed error message when the response has an error', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((_message, callback) => {
      (callback as (response: unknown) => void)({ error: 'profile not found' });
    });

    await expect(sendToBackground('/profile', undefined)).rejects.toThrow('profile not found');
  });

  it('forwards an explicit method (e.g. GET) in the message', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((_message, callback) => {
      (callback as (response: unknown) => void)({ data: { fullName: 'Jane Doe' } });
    });

    await sendToBackground('/profile', undefined, 'GET');

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { path: '/profile', body: undefined, method: 'GET' },
      expect.any(Function),
    );
  });
});
