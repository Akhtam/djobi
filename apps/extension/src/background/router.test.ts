import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJobPageData, setJobPageData } from './jobPageStore';
import { handleTypedMessage } from './router';

describe('handleTypedMessage', () => {
  let tabsSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tabsSendMessage = vi.fn();
    vi.stubGlobal('chrome', { tabs: { sendMessage: tabsSendMessage } });
  });

  it('stores a REPORT_JOB_PAGE message keyed by the sending tab', () => {
    handleTypedMessage(
      { type: 'REPORT_JOB_PAGE', pageText: 'Senior Engineer at Acme', fields: [] },
      { tab: { id: 7 } } as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(getJobPageData(7)).toEqual({ pageText: 'Senior Engineer at Acme', fields: [] });
  });

  it('responds to GET_JOB_PAGE_DATA with the stored data for the requested tabId', () => {
    setJobPageData(8, { pageText: 'Senior Engineer at Acme', fields: [] });
    const sendResponse = vi.fn();

    handleTypedMessage({ type: 'GET_JOB_PAGE_DATA', tabId: 8 }, {} as chrome.runtime.MessageSender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({
      data: { pageText: 'Senior Engineer at Acme', fields: [] },
    });
  });

  it('relays a FILL_FORM message to the target tab and forwards its response', () => {
    tabsSendMessage.mockImplementation((_tabId, _message, callback) => callback({ ok: true }));
    const sendResponse = vi.fn();
    const fields = [
      { id: 'f1', label: 'Email', inputType: 'text', selector: '#f1', category: 'email' as const },
    ];

    handleTypedMessage(
      { type: 'FILL_FORM', tabId: 7, fields, values: { f1: 'jane@example.com' } },
      {} as chrome.runtime.MessageSender,
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
