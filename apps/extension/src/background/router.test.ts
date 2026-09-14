import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDetectedPage } from '../lib/tabStore/detectedPage';
import { getJobContext } from '../lib/tabStore/jobContext';
import { getPipelineRun, setPipelineRun } from '../lib/tabStore/pipelineRun';
import { handleTypedMessage } from './router';
import { pipelineRunFixture, profile } from '../lib/testFixtures';

const {
  mockEnrichWithApiOracle,
  mockRunAnalysis,
  mockRunFill,
  mockRunSaveApplication,
  /** Stands in for the real adapter, which the router names as its default `deps`. */
  productionDeps,
} = vi.hoisted(() => ({
  mockEnrichWithApiOracle: vi.fn(),
  mockRunAnalysis: vi.fn(),
  mockRunFill: vi.fn(),
  mockRunSaveApplication: vi.fn(),
  productionDeps: {
    backend: 'production-backend',
    page: 'production-page',
    detection: 'production-detection',
  },
}));

vi.mock('./apiDetectors', () => ({ enrichWithApiOracle: mockEnrichWithApiOracle }));
vi.mock('./applicationPipeline', () => ({
  productionDeps,
  runAnalysis: mockRunAnalysis,
  runFill: mockRunFill,
  runSaveApplication: mockRunSaveApplication,
}));

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

  it("returns the Analysis task for rejection observation without deciding whether Chrome's message channel stays open", async () => {
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
      productionDeps,
      undefined,
    );
    await expect(returned).resolves.toBeUndefined();
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
      productionDeps,
      true,
    );
  });

  it("resolves with the claim's verdict, reported through the callback runFill is given", async () => {
    mockRunFill.mockImplementation(
      async (
        _tabId: number,
        _profile: unknown,
        _deps: unknown,
        _expectedRunId: string,
        onClaimed: (outcome: unknown) => void,
      ) => {
        onClaimed({ claimed: true });
      },
    );

    const returned = handleTypedMessage(
      { type: 'START_FILL', tabId: 7, profile, expectedRunId: 'run-1' },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockRunFill).toHaveBeenCalledWith(
      7,
      profile,
      productionDeps,
      'run-1',
      expect.any(Function),
    );
    await expect(returned).resolves.toEqual({ claimed: true });
  });

  it("resolves with the claim's verdict, reported through the callback runSaveApplication is given", async () => {
    mockRunSaveApplication.mockImplementation(
      async (
        _tabId: number,
        _deps: unknown,
        _expectedRunId: string,
        onClaimed: (outcome: unknown) => void,
      ) => {
        onClaimed({ claimed: false, reason: 'busy' });
      },
    );

    const returned = handleTypedMessage(
      { type: 'START_SAVE_APPLICATION', tabId: 7, expectedRunId: 'run-1' },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockRunSaveApplication).toHaveBeenCalledWith(
      7,
      productionDeps,
      'run-1',
      expect.any(Function),
    );
    await expect(returned).resolves.toEqual({ claimed: false, reason: 'busy' });
  });

  it('saves the application when the page reports the candidate submitting a form we filled', async () => {
    const returned = handleTypedMessage({ type: 'REPORT_SUBMISSION', runId: 'run-1' }, {
      tab: { id: 7 },
    } as chrome.runtime.MessageSender);

    // The same Save Step the panel's Save button runs, named with the run the fill belonged to —
    // a submission arriving after a re-analysis must not save the newer run's posting.
    expect(mockRunSaveApplication).toHaveBeenCalledWith(7, productionDeps, 'run-1');
    await expect(returned).resolves.toBeUndefined();
  });

  it('ignores a submission report from a sender with no tab, since there is no run to save', async () => {
    await handleTypedMessage(
      { type: 'REPORT_SUBMISSION', runId: 'run-1' },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockRunSaveApplication).not.toHaveBeenCalled();
  });

  it('resolves with a refusal, logged locally, when the step rejects before the claim is decided', async () => {
    const failure = new Error('session storage unavailable');
    mockRunFill.mockRejectedValue(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // `START_FILL`/`START_SAVE_APPLICATION` never reject `handleTypedMessage` — a caller waiting on
    // this promise has no better answer for an early fault than the same refusal a losing claim
    // already reports, and the fault itself is still logged, just here rather than at the caller.
    await expect(
      handleTypedMessage(
        { type: 'START_FILL', tabId: 7, profile, expectedRunId: 'run-1' },
        {} as chrome.runtime.MessageSender,
      ),
    ).resolves.toEqual({ claimed: false, reason: 'busy' });
    expect(error).toHaveBeenCalledWith('[djobi] fill step failed', failure);
    error.mockRestore();
  });

  /**
   * The seam that lets `panel/panelTestHarness.ts` send real messages through this dispatch instead
   * of re-implementing it. Every step-starting branch has to honour it: one that quietly kept the
   * production adapter would reach the network from a test.
   */
  it('hands a substituted adapter to every step it starts', () => {
    const deps = { backend: 'fake-backend', page: 'fake-page' } as never;
    const sender = {} as chrome.runtime.MessageSender;

    handleTypedMessage(
      {
        type: 'START_ANALYSIS',
        tabId: 7,
        tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        profile,
        jobDescription: 'Senior Engineer at Acme...',
      },
      sender,
      deps,
    );
    handleTypedMessage(
      { type: 'START_FILL', tabId: 7, profile, expectedRunId: 'run-1' },
      sender,
      deps,
    );
    handleTypedMessage(
      { type: 'START_SAVE_APPLICATION', tabId: 7, expectedRunId: 'run-1' },
      sender,
      deps,
    );

    expect(mockRunAnalysis.mock.calls[0]![4]!).toBe(deps);
    expect(mockRunFill).toHaveBeenCalledWith(7, profile, deps, 'run-1', expect.any(Function));
    expect(mockRunSaveApplication).toHaveBeenCalledWith(7, deps, 'run-1', expect.any(Function));
  });

  it('routes UPDATE_RUN through the background store queue and scopes it to its run', async () => {
    await setPipelineRun(
      7,
      pipelineRunFixture({
        runId: 'run-7',
        tabUrl: null,
        jobDescription: 'original',
        jobInfo: null,
        tailoredResume: null,
      }),
    );

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
