import type { Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDetectedPage, getJobContext, getPipelineRun, setPipelineRun } from '../lib/tabStore';
import { handleTypedMessage } from './router';

const { mockEnrichWithApiOracle, mockRunAnalysis, mockRunFill, mockRunSaveApplication } =
  vi.hoisted(() => ({
    mockEnrichWithApiOracle: vi.fn(),
    mockRunAnalysis: vi.fn(),
    mockRunFill: vi.fn(),
    mockRunSaveApplication: vi.fn(),
  }));

vi.mock('./apiDetectors', () => ({ enrichWithApiOracle: mockEnrichWithApiOracle }));
vi.mock('./applicationPipeline', () => ({
  runAnalysis: mockRunAnalysis,
  runFill: mockRunFill,
  runSaveApplication: mockRunSaveApplication,
}));

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

describe('handleTypedMessage', () => {
  let tabsSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tabsSendMessage = vi.fn();
    const data = new Map<string, unknown>();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: tabsSendMessage },
      storage: {
        session: {
          get: vi.fn((key: string) =>
            Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {}),
          ),
          set: vi.fn((items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) data.set(key, value);
            return Promise.resolve();
          }),
          remove: vi.fn((key: string) => {
            data.delete(key);
            return Promise.resolve();
          }),
        },
      },
    });
    mockEnrichWithApiOracle.mockReset();
    mockEnrichWithApiOracle.mockResolvedValue([]);
    mockRunAnalysis.mockReset();
    mockRunAnalysis.mockResolvedValue(undefined);
    mockRunFill.mockReset();
    mockRunFill.mockResolvedValue(undefined);
    mockRunSaveApplication.mockReset();
    mockRunSaveApplication.mockResolvedValue(undefined);
  });

  it('stores a REPORT_JOB_PAGE message keyed by the sending tab', async () => {
    handleTypedMessage({ type: 'REPORT_JOB_PAGE', fields: [] }, {
      tab: { id: 7 },
    } as chrome.runtime.MessageSender);

    await vi.waitFor(async () =>
      expect(await getDetectedPage(7)).toEqual({
        fields: [],
      }),
    );
  });

  it("records each frame separately, so an ATS form in an iframe isn't overwritten by its host page", async () => {
    const hostField = {
      id: 'stray',
      label: 'stray',
      inputType: 'file',
      selector: '#stray',
      category: 'resume_upload' as const,
      required: false,
      elementRole: 'native' as const,
    };
    const formFields = [
      { ...hostField, id: 'a', selector: '#a' },
      { ...hostField, id: 'b', selector: '#b' },
    ];

    // The iframe holding the real form reports first, then the host page reports its stray input.
    handleTypedMessage({ type: 'REPORT_JOB_PAGE', fields: formFields }, {
      tab: { id: 7 },
      frameId: 4,
    } as chrome.runtime.MessageSender);
    handleTypedMessage({ type: 'REPORT_JOB_PAGE', fields: [hostField] }, {
      tab: { id: 7 },
      frameId: 0,
    } as chrome.runtime.MessageSender);

    await vi.waitFor(async () =>
      // The frame with the most fields wins — the iframe holding the real form.
      expect((await getDetectedPage(7))?.fields).toHaveLength(2),
    );
  });

  it('stores REPORT_JOB_PAGE data even when the sending tab has no url (never invokes the API oracle)', () => {
    handleTypedMessage({ type: 'REPORT_JOB_PAGE', fields: [] }, {
      tab: { id: 9 },
    } as chrome.runtime.MessageSender);

    expect(mockEnrichWithApiOracle).not.toHaveBeenCalled();
  });

  it("gives the oracle the sending frame's url, not the tab's — an ATS form is usually an iframe on a company careers domain", async () => {
    mockEnrichWithApiOracle.mockResolvedValue([]);

    handleTypedMessage({ type: 'REPORT_JOB_PAGE', fields: [] }, {
      tab: { id: 7, url: 'https://careers.acme.com/openings' },
      frameId: 3,
      url: 'https://job-boards.greenhouse.io/acme/jobs/8080711',
    } as chrome.runtime.MessageSender);

    // The tab's url names no posting, so passing it meant no oracle ever recognized the platform.
    await vi.waitFor(() =>
      expect(mockEnrichWithApiOracle).toHaveBeenCalledWith(
        'https://job-boards.greenhouse.io/acme/jobs/8080711',
        [],
      ),
    );
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
        options: [
          { label: 'Yes', selector: null },
          { label: 'No', selector: null },
        ],
      },
    ];
    mockEnrichWithApiOracle.mockResolvedValue(enrichedFields);

    handleTypedMessage({ type: 'REPORT_JOB_PAGE', fields: [] }, {
      tab: { id: 7, url: 'https://job-boards.greenhouse.io/greenhouse/jobs/8080711' },
    } as chrome.runtime.MessageSender);

    await vi.waitFor(() =>
      expect(mockEnrichWithApiOracle).toHaveBeenCalledWith(
        'https://job-boards.greenhouse.io/greenhouse/jobs/8080711',
        [],
      ),
    );

    await vi.waitFor(async () =>
      expect(await getDetectedPage(7)).toEqual({
        fields: enrichedFields,
      }),
    );
  });

  it("starts the Analysis Step in the background without holding the message channel open, so a panel that closes right after sending it doesn't block the run", () => {
    const returned = handleTypedMessage(
      {
        type: 'START_ANALYSIS',
        tabId: 7,
        tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        profile,
        jobDescription: 'Senior Engineer at Acme...',
      },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockRunAnalysis).toHaveBeenCalledWith(
      7,
      'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      'Senior Engineer at Acme...',
      undefined,
      undefined,
    );
    // Chrome holds the channel open only for a listener that returns `true`. Returning nothing at
    // all is what makes that impossible to get wrong here.
    expect(returned).toBeUndefined();
  });

  it('carries the candidate\'s "analyze anyway" through to the run, so the duplicate guard is skipped', () => {
    handleTypedMessage(
      {
        type: 'START_ANALYSIS',
        tabId: 7,
        tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        profile,
        jobDescription: 'Senior Engineer at Acme...',
        force: true,
      },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockRunAnalysis).toHaveBeenCalledWith(
      7,
      'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      'Senior Engineer at Acme...',
      undefined,
      true,
    );
  });

  it('starts the Fill Step in the background without holding the message channel open', () => {
    const returned = handleTypedMessage(
      { type: 'START_FILL', tabId: 7, profile },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockRunFill).toHaveBeenCalledWith(7, profile);
    expect(returned).toBeUndefined();
  });

  it('starts saving in the background without holding the message channel open', () => {
    const returned = handleTypedMessage(
      { type: 'START_SAVE_APPLICATION', tabId: 7 },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockRunSaveApplication).toHaveBeenCalledWith(7);
    expect(returned).toBeUndefined();
  });

  it('routes UPDATE_RUN through the background store queue and scopes it to its run', async () => {
    await setPipelineRun(7, {
      runId: 'run-7',
      status: 'review',
      tabUrl: null,
      jobPageData: { fields: [] },
      jobDescription: 'original',
      jobInfo: null,
      tailoredResume: null,
      answers: [],
      failure: null,
      unresolvedRequiredFields: [],
      filledFieldCount: 0,
      fillOutcome: null,
      applicationId: null,
      duplicateOf: null,
    });

    handleTypedMessage(
      {
        type: 'UPDATE_RUN',
        tabId: 7,
        runId: 'run-7',
        updates: { answers: [], jobDescription: 'edited' },
      },
      {} as chrome.runtime.MessageSender,
    );

    await vi.waitFor(async () =>
      expect(await getPipelineRun(7)).toMatchObject({ jobDescription: 'edited' }),
    );
  });

  it('retains an editable Job Description before Analysis starts', async () => {
    handleTypedMessage(
      {
        type: 'UPDATE_JOB_CONTEXT',
        tabId: 7,
        tabUrl: 'https://jobs.ashbyhq.com/acme/job-id',
        jobDescription: 'Scraped posting text',
        source: 'scraped',
      },
      {} as chrome.runtime.MessageSender,
    );

    await vi.waitFor(async () =>
      expect(await getJobContext(7)).toMatchObject({
        sourceUrl: 'https://jobs.ashbyhq.com/acme/job-id',
        jobDescription: 'Scraped posting text',
        source: 'scraped',
      }),
    );
  });
});
