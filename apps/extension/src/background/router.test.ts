import type { Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJobPageData, setJobPageData } from './jobPageStore';
import { handleTypedMessage } from './router';

const { mockEnrichWithApiOracle, mockRunAnalysis, mockRunFill } = vi.hoisted(() => ({
  mockEnrichWithApiOracle: vi.fn(),
  mockRunAnalysis: vi.fn(),
  mockRunFill: vi.fn(),
}));

vi.mock('./apiDetectors', () => ({ enrichWithApiOracle: mockEnrichWithApiOracle }));
vi.mock('./pipelineRunner', () => ({ runAnalysis: mockRunAnalysis, runFill: mockRunFill }));

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
};

describe('handleTypedMessage', () => {
  let tabsSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tabsSendMessage = vi.fn();
    vi.stubGlobal('chrome', { tabs: { sendMessage: tabsSendMessage } });
    mockEnrichWithApiOracle.mockReset();
    mockEnrichWithApiOracle.mockResolvedValue([]);
    mockRunAnalysis.mockReset();
    mockRunAnalysis.mockResolvedValue(undefined);
    mockRunFill.mockReset();
    mockRunFill.mockResolvedValue(undefined);
  });

  it('stores a REPORT_JOB_PAGE message keyed by the sending tab', () => {
    handleTypedMessage(
      { type: 'REPORT_JOB_PAGE', pageText: 'Senior Engineer at Acme', fields: [] },
      { tab: { id: 7 } } as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(getJobPageData(7)).toEqual({ pageText: 'Senior Engineer at Acme', fields: [] });
  });

  it('stores REPORT_JOB_PAGE data even when the sending tab has no url (never invokes the API oracle)', () => {
    handleTypedMessage(
      { type: 'REPORT_JOB_PAGE', pageText: 'Senior Engineer at Acme', fields: [] },
      { tab: { id: 9 } } as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(mockEnrichWithApiOracle).not.toHaveBeenCalled();
  });

  it('re-stores REPORT_JOB_PAGE data with API-enriched fields once the Greenhouse oracle resolves', async () => {
    const enrichedFields = [
      {
        id: 'f1',
        label: 'Are you authorized to work in the US?',
        inputType: 'combobox',
        selector: '#f1',
        category: 'question' as const,
        required: true,
        elementRole: 'combobox' as const,
        options: ['Yes', 'No'],
      },
    ];
    mockEnrichWithApiOracle.mockResolvedValue(enrichedFields);

    handleTypedMessage(
      { type: 'REPORT_JOB_PAGE', pageText: 'Senior Engineer at Acme', fields: [] },
      {
        tab: { id: 7, url: 'https://job-boards.greenhouse.io/greenhouse/jobs/8080711' },
      } as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(getJobPageData(7)).toEqual({ pageText: 'Senior Engineer at Acme', fields: [] });
    expect(mockEnrichWithApiOracle).toHaveBeenCalledWith(
      'https://job-boards.greenhouse.io/greenhouse/jobs/8080711',
      [],
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(getJobPageData(7)).toEqual({
      pageText: 'Senior Engineer at Acme',
      fields: enrichedFields,
    });
  });

  it('responds to GET_JOB_PAGE_DATA with the stored data for the requested tabId', () => {
    setJobPageData(8, { pageText: 'Senior Engineer at Acme', fields: [] });
    const sendResponse = vi.fn();

    handleTypedMessage(
      { type: 'GET_JOB_PAGE_DATA', tabId: 8 },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith({
      data: { pageText: 'Senior Engineer at Acme', fields: [] },
    });
  });

  it("starts the Analysis Step in the background without holding the message channel open, so a panel that closes right after sending it doesn't block the run", () => {
    const sendResponse = vi.fn();

    const keepsChannelOpen = handleTypedMessage(
      {
        type: 'START_ANALYSIS',
        tabId: 7,
        tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        profile,
        pageTextOverride: null,
      },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(mockRunAnalysis).toHaveBeenCalledWith(
      7,
      'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      null,
    );
    expect(keepsChannelOpen).toBe(false);
  });

  it('starts the Fill Step in the background without holding the message channel open', () => {
    const sendResponse = vi.fn();

    const keepsChannelOpen = handleTypedMessage(
      { type: 'START_FILL', tabId: 7, profile },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(mockRunFill).toHaveBeenCalledWith(7, profile);
    expect(keepsChannelOpen).toBe(false);
  });
});
