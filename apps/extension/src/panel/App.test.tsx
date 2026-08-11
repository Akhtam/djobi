import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchResumePdf } from '../lib/fetchResumePdf';
import { patchPipelineRun, setPipelineRun, type PipelineStatus } from '../lib/pipelineRunStore';
import { App } from './App';

vi.mock('../lib/fetchResumePdf', () => ({ fetchResumePdf: vi.fn() }));

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

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

const tailoredResume: TailoredResume = {
  summary: 'Tailored summary.',
  skills: [],
  workExperience: [],
};

const questionField: DetectedField = {
  id: 'f-why',
  label: 'Why do you want to work here?',
  inputType: 'textarea',
  selector: '#why-field',
  category: 'question',
  required: false,
  elementRole: 'native',
};

const answers: QuestionAnswer[] = [
  {
    fieldId: 'f-why',
    question: 'Why do you want to work here?',
    answer: 'Draft answer.',
    sourceStoryIds: [],
  },
];

const jobPageData = { pageText: 'Senior Engineer at Acme...', fields: [questionField] };

/**
 * In-memory stand-in for `chrome.storage.session`, close enough to the real callback/Promise API
 * for `pipelineRunStore.ts`. Auto-fires `onChanged` on `set`/`remove`, like real Chrome does
 * (including back to the same context that wrote the change) — this is what exercises `App.tsx`'s
 * own-write echo guard, not just the hydrate-on-mount path.
 */
function createSessionStorageStub() {
  const data = new Map<string, unknown>();
  const listeners: ((changes: Record<string, { newValue?: unknown }>, areaName: string) => void)[] =
    [];

  function notify(changes: Record<string, { newValue?: unknown }>) {
    for (const listener of listeners) listener(changes, 'session');
  }

  return {
    session: {
      get: vi.fn((key: string) => Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {})),
      set: vi.fn((items: Record<string, unknown>) => {
        const changes: Record<string, { newValue?: unknown }> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { newValue: value };
          data.set(key, value);
        }
        notify(changes);
        return Promise.resolve();
      }),
      remove: vi.fn((key: string) => {
        data.delete(key);
        notify({ [key]: { newValue: undefined } });
        return Promise.resolve();
      }),
    },
    onChanged: {
      addListener: vi.fn((listener: (typeof listeners)[number]) => listeners.push(listener)),
      removeListener: vi.fn((listener: (typeof listeners)[number]) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }),
    },
  };
}

interface AnalysisOutcome {
  status: Extract<PipelineStatus, 'review' | 'analyze-error'>;
  jobInfo?: JobInfo;
  tailoredResume?: TailoredResume;
  answers?: QuestionAnswer[];
}

interface FillOutcome {
  status: Extract<PipelineStatus, 'filled' | 'fill-error'>;
  unresolvedRequiredFields?: DetectedField[];
}

interface StubOptions {
  tabUrl: string;
  tabId?: number;
  profile: Profile | null;
  jobPageData?: { pageText: string; fields: DetectedField[] } | null;
  /** Share one `chrome.storage.session` across multiple `stubChrome`/`render` calls — simulates
   *  the panel closing and reopening (unmount + fresh `render`), both of which see the same
   *  underlying session storage in real Chrome. */
  sessionStorage?: ReturnType<typeof createSessionStorageStub>;
  /** Outcomes for successive `START_ANALYSIS` messages, consumed in order (repeats the last entry
   *  once exhausted) — simulates `background/pipelineRunner.ts` completing the Analysis Step and
   *  checkpointing the result into `pipelineRunStore`. Defaults to one successful analysis. */
  analysisOutcomes?: AnalysisOutcome[];
  /** Same idea as `analysisOutcomes`, for `START_FILL`. Defaults to one successful fill. */
  fillOutcomes?: FillOutcome[];
  /** If true, a `START_FILL` message doesn't checkpoint its outcome until the returned
   *  `resolveFill()` is called — simulates a Fill Step still in flight in the background. */
  holdFill?: boolean;
}

/**
 * Stubs `chrome.tabs.query` (active tab) and `chrome.runtime.sendMessage`. `GET_JOB_PAGE_DATA` and
 * `/profile` are answered directly; `START_ANALYSIS`/`START_FILL` are acknowledged (no response
 * payload, matching the real fire-and-forget handler) and, like `background/pipelineRunner.ts`
 * would, checkpoint an outcome into `pipelineRunStore` — these tests assert on that store ->
 * render wiring, not on how analysis/filling itself happens (that's `pipeline.test.ts`'s job).
 */
function stubChrome(options: StubOptions) {
  const openOptionsPage = vi.fn();
  let analysisCallIndex = 0;
  let fillCallIndex = 0;
  let resolveFillFn: (() => void) | null = null;

  const sendMessage = vi.fn(
    (message: Record<string, unknown>, callback: (response: unknown) => void) => {
      if (message.type === 'GET_JOB_PAGE_DATA') {
        callback({ data: options.jobPageData ?? null });
        return;
      }
      if (message.path === '/profile') {
        callback({ data: options.profile });
        return;
      }
      if (message.type === 'START_ANALYSIS') {
        const outcomes = options.analysisOutcomes ?? [
          { status: 'review' as const, jobInfo, tailoredResume, answers },
        ];
        const outcome = outcomes[Math.min(analysisCallIndex, outcomes.length - 1)];
        analysisCallIndex += 1;
        const tabId = message.tabId as number;
        const pageTextOverride = message.pageTextOverride as string | null;
        const pageText = pageTextOverride ?? options.jobPageData?.pageText ?? '';
        void setPipelineRun(tabId, {
          status: outcome.status,
          tabUrl: message.tabUrl as string | null,
          jobPageData: options.jobPageData
            ? { ...options.jobPageData, pageText }
            : { pageText, fields: [] },
          pageTextOverride,
          jobInfo: outcome.jobInfo ?? null,
          tailoredResume: outcome.tailoredResume ?? null,
          answers: outcome.answers ?? [],
          unresolvedRequiredFields: [],
        });
        callback({ data: undefined });
        return;
      }
      if (message.type === 'START_FILL') {
        const outcomes = options.fillOutcomes ?? [{ status: 'filled' as const }];
        const outcome = outcomes[Math.min(fillCallIndex, outcomes.length - 1)];
        fillCallIndex += 1;
        const tabId = message.tabId as number;
        const apply = () =>
          void patchPipelineRun(tabId, {
            status: outcome.status,
            unresolvedRequiredFields: outcome.unresolvedRequiredFields ?? [],
          });
        if (options.holdFill) resolveFillFn = apply;
        else apply();
        callback({ data: undefined });
        return;
      }
      callback({ data: undefined });
    },
  );
  const onActivated = { addListener: vi.fn(), removeListener: vi.fn() };
  const onUpdated = { addListener: vi.fn(), removeListener: vi.fn() };
  const storage = options.sessionStorage ?? createSessionStorageStub();
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn((_query: unknown, callback: (tabs: { id: number; url: string }[]) => void) =>
        callback([{ id: options.tabId ?? 1, url: options.tabUrl }]),
      ),
      get: vi.fn((tabId: number, callback: (tab: { id: number; url: string }) => void) =>
        callback({ id: tabId, url: options.tabUrl }),
      ),
      onActivated,
      onUpdated,
    },
    runtime: { sendMessage, openOptionsPage },
    storage,
  });
  return {
    openOptionsPage,
    sendMessage,
    onActivated,
    onUpdated,
    sessionStorage: storage,
    resolveFill: () => resolveFillFn?.(),
  };
}

/** Clicks the pre-analysis "Analyze" button, present once a job page is detected but before analysis runs. */
async function clickAnalyze() {
  fireEvent.click(await screen.findByRole('button', { name: 'Analyze' }));
}

/** Filters `sendMessage` mock calls down to a given `TypedMessage` type, e.g. `'START_ANALYSIS'`. */
function callsOfType(sendMessage: ReturnType<typeof vi.fn>, type: string) {
  return sendMessage.mock.calls.filter(([message]) => message?.type === type);
}

describe('panel App', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fetchResumePdf).mockReset();
    // jsdom doesn't implement URL.createObjectURL/revokeObjectURL — give the resume-preview
    // code paths deterministic stubs so an `App` unmount (which revokes any created URL) and a
    // preview click both behave identically to real Chrome.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:resume-preview'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  it('prompts to set up a profile when none exists yet', async () => {
    const { openOptionsPage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile: null,
    });

    render(<App />);

    await screen.findByText('Set up your profile to get started.');
    fireEvent.click(screen.getByRole('button', { name: 'Open profile settings' }));
    expect(openOptionsPage).toHaveBeenCalled();
  });

  it('shows a paste box and an "Analyze" button immediately on open, even before/without any job page being detected', async () => {
    const { sendMessage } = stubChrome({
      tabUrl: 'https://example.com',
      profile,
      jobPageData: null,
    });

    render(<App />);

    await screen.findByRole('button', { name: 'Analyze' });
    expect(screen.getByPlaceholderText(/paste the job description/i)).toBeInTheDocument();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
  });

  it('pre-fills the paste box with the scraped job description once a job page is detected in the background', async () => {
    const { sendMessage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<App />);

    await screen.findByRole('button', { name: 'Analyze' });
    expect(screen.getByDisplayValue(jobPageData.pageText)).toBeInTheDocument();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
  });

  it("analyzes pasted text even when no job page was ever detected on the page, so pasting doesn't depend on auto-detection succeeding", async () => {
    const { sendMessage } = stubChrome({
      tabUrl: 'https://example.com',
      tabId: 1,
      profile,
      jobPageData: null,
    });

    render(<App />);
    const textarea = await screen.findByPlaceholderText(/paste the job description/i);
    fireEvent.change(textarea, { target: { value: 'Pasted job description text.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1));
    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: 'START_ANALYSIS',
        tabId: 1,
        tabUrl: 'https://example.com',
        profile,
        pageTextOverride: 'Pasted job description text.',
      },
      expect.any(Function),
    );
  });

  it('disables "Analyze" when there is nothing to analyze yet (no paste, no detected job page)', async () => {
    stubChrome({ tabUrl: 'https://example.com', profile, jobPageData: null });

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('analyzes with manually-edited job description text when edited before clicking Analyze (paste fallback for pages where scraping misses the job description, e.g. tabbed Overview/Application ATS embeds)', async () => {
    const { sendMessage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      tabId: 1,
      profile,
      jobPageData,
    });

    render(<App />);
    await screen.findByRole('button', { name: 'Analyze' });

    fireEvent.change(screen.getByDisplayValue(jobPageData.pageText), {
      target: { value: 'Pasted job description text.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'START_ANALYSIS',
        pageTextOverride: 'Pasted job description text.',
      }),
      expect.any(Function),
    );
  });

  it('shows an editable review once analysis succeeds', async () => {
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();

    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill form' })).toBeInTheDocument();
  });

  it('reveals a job-description editor pre-filled with the scraped text when "Edit job description" is clicked on the review screen', async () => {
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));

    expect(screen.getByDisplayValue(jobPageData.pageText)).toBeInTheDocument();
  });

  it('disables "Re-analyze" when the review-screen editor is cleared to empty, rather than silently analyzing blank text', async () => {
    const { sendMessage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    fireEvent.change(screen.getByDisplayValue(jobPageData.pageText), { target: { value: '' } });

    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeDisabled();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1);
  });

  it('re-analyzes with the manually-edited job description text from the review screen', async () => {
    const { sendMessage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    fireEvent.change(screen.getByDisplayValue(jobPageData.pageText), {
      target: { value: 'Pasted job description text.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(2));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[1][0]).toMatchObject({
      pageTextOverride: 'Pasted job description text.',
    });
  });

  it('shows an error and retries analysis when the user clicks "Try again"', async () => {
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      analysisOutcomes: [
        { status: 'analyze-error' },
        { status: 'review', jobInfo, tailoredResume, answers },
      ],
    });

    render(<App />);
    await clickAnalyze();

    await screen.findByText('Something went wrong analyzing this job posting.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Senior Engineer at Acme');
  });

  it('fills the form and saves the application when "Fill form" is clicked', async () => {
    const { sendMessage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText('Filled and application saved.');
    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'START_FILL', tabId: 1, profile },
      expect.any(Function),
    );
  });

  it("warns about required fields that couldn't be resolved, instead of reporting a plain success when the fill is actually incomplete", async () => {
    const unresolvedField: DetectedField = {
      id: 'f-mystery',
      label: 'Referral code',
      inputType: 'text',
      selector: '#mystery-field',
      category: 'unknown',
      required: true,
      elementRole: 'native',
    };
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      fillOutcomes: [{ status: 'filled', unresolvedRequiredFields: [unresolvedField] }],
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/couldn't be resolved/);
    expect(screen.getByText('Referral code')).toBeInTheDocument();
    expect(screen.queryByText('Filled and application saved.')).not.toBeInTheDocument();
  });

  it('ignores extra clicks on "Fill form" while a fill is already in flight', async () => {
    const { sendMessage, resolveFill } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      holdFill: true,
    });

    render(<App />);
    await clickAnalyze();
    const fillButton = await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(fillButton);
    fireEvent.click(fillButton);

    expect(callsOfType(sendMessage, 'START_FILL')).toHaveLength(1);

    resolveFill();
    await screen.findByText('Filled and application saved.');
  });

  it('shows an error and retries filling when the user clicks "Try again"', async () => {
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      fillOutcomes: [{ status: 'fill-error' }, { status: 'filled' }],
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText('Something went wrong filling the form and saving the application.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Filled and application saved.');
  });

  it('resets to the bootstrap screen when the active tab changes, so the panel (which survives tab switches) never shows a stale review for the previous tab', async () => {
    const { onActivated } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    const [handleActivated] = onActivated.addListener.mock.calls[0];
    handleActivated({ tabId: 2 });

    await screen.findByRole('button', { name: 'Analyze' });
    expect(screen.queryByText('Senior Engineer at Acme')).not.toBeInTheDocument();
  });

  it('checkpoints review progress (including edited answers) to the pipeline run store, so a reopened panel on the same tab restores it instead of starting over', async () => {
    const sessionStorage = createSessionStorageStub();
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
      sessionStorage,
    });

    const first = render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');
    fireEvent.change(screen.getByDisplayValue('Draft answer.'), {
      target: { value: 'Edited answer.' },
    });
    await vi.waitFor(() => expect(sessionStorage.session.set).toHaveBeenCalled());
    first.unmount(); // simulates the panel closing

    const { sendMessage: secondSendMessage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
      sessionStorage, // same underlying chrome.storage.session — simulates reopening the panel
    });
    render(<App />); // simulates reopening the panel

    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Edited answer.')).toBeInTheDocument();
    expect(callsOfType(secondSendMessage, 'START_ANALYSIS')).toHaveLength(0); // rehydrated, not re-analyzed
  });

  it('reflects a pipeline run update written from elsewhere (e.g. the background service worker) via chrome.storage.onChanged, while the panel stays mounted', async () => {
    const sessionStorage = createSessionStorageStub();
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
      sessionStorage,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();

    // Simulates background/pipelineRunner.ts patching the store directly, independent of this
    // mounted panel's own writes.
    await patchPipelineRun(1, {
      answers: [{ ...answers[0], answer: 'Updated from elsewhere.' }],
    });

    await screen.findByDisplayValue('Updated from elsewhere.');
  });

  it('shows a "Preview tailored resume" button on the review screen once analysis succeeds', async () => {
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    expect(screen.getByRole('button', { name: 'Preview tailored resume' })).toBeInTheDocument();
  });

  it('renders the tailored resume PDF in a preview when "Preview tailored resume" is clicked', async () => {
    vi.mocked(fetchResumePdf).mockResolvedValue(new Uint8Array([37, 80, 68, 70]).buffer);
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));

    const frame = await screen.findByTitle('Tailored resume');
    expect(frame).toHaveAttribute('src', 'blob:resume-preview');
    expect(fetchResumePdf).toHaveBeenCalledWith(profile, tailoredResume);
  });

  it('shows an error message when the resume PDF fails to render', async () => {
    vi.mocked(fetchResumePdf).mockRejectedValue(new Error('render failed'));
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));

    await screen.findByText(/couldn't render/i);
  });
});
