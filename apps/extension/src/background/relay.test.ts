import { beforeEach, describe, expect, it, vi } from 'vitest';

const callBackendMock = vi.fn();
vi.mock('./callBackend', () => ({ callBackend: callBackendMock }));

const { handleRelayMessage } = await import('./relay');

describe('handleRelayMessage', () => {
  beforeEach(() => {
    callBackendMock.mockReset();
  });

  it('relays { path, body } to callBackend and responds with { data } on success', async () => {
    callBackendMock.mockResolvedValue({ company: 'Acme' });
    const sendResponse = vi.fn();

    const keepChannelOpen = handleRelayMessage(
      { path: '/extract-job', body: { pageText: 'Senior Engineer at Acme...' } },
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

    handleRelayMessage({ path: '/extract-job', body: {} }, sendResponse);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ error: 'pageText is required' }),
    );
  });

  it('forwards an explicit method (e.g. GET) to callBackend', async () => {
    callBackendMock.mockResolvedValue({ fullName: 'Jane Doe' });
    const sendResponse = vi.fn();

    handleRelayMessage({ path: '/profile', body: undefined, method: 'GET' }, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(callBackendMock).toHaveBeenCalledWith('/profile', undefined, 'GET');
  });
});
