import { beforeEach, describe, expect, it, vi } from 'vitest';

const callBackendMock = vi.fn();
vi.mock('./callBackend', () => ({ callBackend: callBackendMock }));

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | void;

describe('background relay', () => {
  let listener: Listener;

  beforeEach(async () => {
    vi.resetModules();
    callBackendMock.mockReset();

    const addListener = vi.fn((fn: Listener) => {
      listener = fn;
    });
    vi.stubGlobal('chrome', { runtime: { onMessage: { addListener } } });

    await import('./index');
  });

  it('relays { path, body } to callBackend and responds with { data } on success', async () => {
    callBackendMock.mockResolvedValue({ company: 'Acme' });
    const sendResponse = vi.fn();

    const keepChannelOpen = listener(
      { path: '/extract-job', body: { pageText: 'Senior Engineer at Acme...' } },
      {},
      sendResponse,
    );

    expect(keepChannelOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(callBackendMock).toHaveBeenCalledWith(
      '/extract-job',
      { pageText: 'Senior Engineer at Acme...' },
      undefined,
    );
    expect(sendResponse).toHaveBeenCalledWith({ data: { company: 'Acme' } });
  });

  it('responds with { error } when callBackend rejects', async () => {
    callBackendMock.mockRejectedValue(new Error('pageText is required'));
    const sendResponse = vi.fn();

    listener({ path: '/extract-job', body: {} }, {}, sendResponse);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ error: 'pageText is required' }),
    );
  });

  it('forwards an explicit method (e.g. GET) to callBackend', async () => {
    callBackendMock.mockResolvedValue({ fullName: 'Jane Doe' });
    const sendResponse = vi.fn();

    listener({ path: '/profile', body: undefined, method: 'GET' }, {}, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(callBackendMock).toHaveBeenCalledWith('/profile', undefined, 'GET');
  });
});
