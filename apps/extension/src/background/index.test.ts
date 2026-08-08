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
  let tabsSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    callBackendMock.mockReset();

    const addListener = vi.fn((fn: Listener) => {
      listener = fn;
    });
    tabsSendMessage = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener } },
      tabs: { sendMessage: tabsSendMessage },
    });

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

  it('stores a REPORT_JOB_PAGE message keyed by the sending tab', async () => {
    const { getJobPageData } = await import('./jobPageStore');

    listener(
      { type: 'REPORT_JOB_PAGE', pageText: 'Senior Engineer at Acme', fields: [] },
      { tab: { id: 7 } },
      vi.fn(),
    );

    expect(getJobPageData(7)).toEqual({ pageText: 'Senior Engineer at Acme', fields: [] });
  });

  it('responds to GET_JOB_PAGE_DATA with the stored data for the requested tabId', async () => {
    const { setJobPageData } = await import('./jobPageStore');
    setJobPageData(7, { pageText: 'Senior Engineer at Acme', fields: [] });
    const sendResponse = vi.fn();

    listener({ type: 'GET_JOB_PAGE_DATA', tabId: 7 }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({
      data: { pageText: 'Senior Engineer at Acme', fields: [] },
    });
  });

  it('relays a FILL_FORM message to the target tab and forwards its response', async () => {
    tabsSendMessage.mockImplementation((_tabId, _message, callback) => callback({ ok: true }));
    const sendResponse = vi.fn();
    const fields = [
      { id: 'f1', label: 'Email', inputType: 'text', selector: '#f1', category: 'email' as const },
    ];

    listener(
      { type: 'FILL_FORM', tabId: 7, fields, values: { f1: 'jane@example.com' } },
      {},
      sendResponse,
    );

    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      { type: 'FILL_FORM', fields, values: { f1: 'jane@example.com' }, resumeFile: undefined },
      expect.any(Function),
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});
