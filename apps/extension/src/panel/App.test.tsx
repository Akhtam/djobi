import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis, runFill, type PipelineDeps } from '../background/applicationPipeline';
import { callBackend, callBackendBinary } from '../lib/callBackend';
import { fakeSessionStorage, type FakeSessionStorage } from '../lib/fakeSessionStorage';
import { getPipelineRun, patchPipelineRun, reportDetectedPage } from '../lib/tabStore';
import { App } from './App';

// The panel's backend seam: the profile it boots with, and the resume PDF it previews on demand.
vi.mock('../lib/callBackend', () => ({ callBackend: vi.fn(), callBackendBinary: vi.fn() }));

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

const emailField: DetectedField = {
  id: 'f-email',
  label: 'Email',
  inputType: 'email',
  selector: '#email-field',
  category: 'email',
  required: false,
  elementRole: 'native',
};

const nameField: DetectedField = {
  id: 'f-name',
  label: 'Full name',
  inputType: 'text',
  selector: '#name-field',
  category: 'full_name',
  required: false,
  elementRole: 'native',
};

// Three fillable fields, so a successful Fill Step reports "Filled 3 fields" — a count the real
// Fill Step now derives from these, rather than one the stub asserts into the store by hand.
const jobPageData = {
  fields: [questionField, emailField, nameField],
};

/** The posting a test pastes in — the Analysis Step's only input now that nothing is scraped. */
const JOB_DESCRIPTION = 'Senior Engineer at Acme, building the platform team.';

interface StubOptions {
  tabUrl: string | null;
  tabId?: number;
  profile: Profile | null;
  jobPageData?: { fields: DetectedField[] } | null;
  /** Share one `chrome.storage.session` across multiple `stubChrome`/`render` calls — simulates
   *  the panel closing and reopening (unmount + fresh `render`), both of which see the same
   *  underlying session storage in real Chrome. */
  sessionStorage?: FakeSessionStorage;
  /** Message to fail successive Analysis Steps with, `null` for success. The last entry repeats. */
  analysisFailures?: (string | null)[];
  /** Same idea for the explicit Save Application action. */
  saveFailures?: (string | null)[];
  /** Applications already saved for the tab's URL — what the duplicate guard on Analyze finds. */
  existingApplications?: { id: string; company: string; roleTitle: string; createdAt: string }[];
  /** If true, the Fill Step hangs at the page-filling call until `resolveFill()` is called —
   *  simulates a Fill Step still in flight in the background. */
  holdFill?: boolean;
  /** If true, the page answers that it kept none of the values — an ATS whose form model discards
   *  every programmatic write. */
  pageKeepsNothing?: boolean;
  /** If true, no frame answers the fill request, so its result cannot be verified. */
  pageDoesNotAnswer?: boolean;
}

/** The entry for successive calls, repeating the last one once the list is exhausted. */
function nth(entries: (string | null)[] | undefined, index: number): string | null {
  if (!entries || entries.length === 0) return null;
  return entries[Math.min(index, entries.length - 1)];
}

/**
 * Stubs `chrome.tabs.query` (active tab), `chrome.runtime.sendMessage` and
 * `chrome.storage.session`, and answers the panel's `GET /profile` through the mocked
 * `callBackend`.
 *
 * `START_ANALYSIS`/`START_FILL` run the **real** `background/applicationPipeline.ts` against the
 * real `lib/tabStore.ts`, with only its `PipelineDeps` stubbed — so these tests cover the whole
 * round trip the panel actually depends on: message -> pipeline -> store -> `chrome.storage
 * .onChanged` -> `usePipelineRun` -> render. This stub used to re-implement the pipeline instead,
 * listing by hand every field the runner checkpoints; a change to what the real one wrote left
 * these tests passing regardless.
 */
async function stubChrome(options: StubOptions) {
  const openOptionsPage = vi.fn();
  let analysisCallIndex = 0;
  let fillCallIndex = 0;
  // Created up front, not when the Fill Step reaches it: a test clicks and then releases within the
  // same tick, long before the pipeline's async path gets as far as `fillPage`.
  let releaseFill!: () => void;
  const fillGate = new Promise<void>((resolve) => {
    releaseFill = resolve;
  });

  vi.mocked(callBackend).mockImplementation((path) =>
    path === '/profile'
      ? Promise.resolve(options.profile)
      : Promise.reject(new Error(`unexpected callBackend path: ${path}`)),
  );

  const deps: PipelineDeps = {
    backend: {
      extractJob: () => {
        const failure = nth(options.analysisFailures, analysisCallIndex++);
        return failure ? Promise.reject(new Error(failure)) : Promise.resolve(jobInfo);
      },
      tailorResume: () => Promise.resolve(tailoredResume),
      answerQuestions: () => Promise.resolve(answers),
      renderResumePdf: () => Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer),
      saveApplication: () => {
        const failure = nth(options.saveFailures, fillCallIndex++);
        return failure
          ? Promise.reject(new Error(failure))
          : Promise.resolve({ id: 'application-1' } as never);
      },
      updateApplication: () => Promise.resolve({ id: 'application-1' } as never),
      findApplicationsByJobUrl: () =>
        Promise.resolve((options.existingApplications ?? []) as never),
    },
    page: {
      fill: (_tabId, command) => {
        const result = options.pageDoesNotAnswer
          ? null
          : options.pageKeepsNothing
            ? { ok: true as const, filledFieldIds: [], resumeAttached: false }
            : {
                ok: true as const,
                filledFieldIds: Object.keys(command.values),
                resumeAttached: command.resume !== undefined,
              };
        return options.holdFill ? fillGate.then(() => result) : Promise.resolve(result);
      },
      // The panel's concern is what the Fill Step reports back, not where its fields came from, so
      // these tests leave the live page unreachable and let it fall back to the run's own detection.
      scan: () => Promise.resolve(null),
    },
  };

  const sendMessage = vi.fn(
    (message: Record<string, unknown>, callback: (response: unknown) => void) => {
      // Fire-and-forget, exactly as `background/router.ts` dispatches them.
      if (message.type === 'START_ANALYSIS') {
        void runAnalysis(
          message.tabId as number,
          message.tabUrl as string | null,
          message.profile as Profile,
          message.jobDescription as string,
          deps,
          message.force as boolean | undefined,
        );
      } else if (message.type === 'START_FILL') {
        void runFill(message.tabId as number, message.profile as Profile, deps);
      } else if (message.type === 'START_SAVE_APPLICATION') {
        void import('../background/applicationPipeline').then(({ runSaveApplication }) =>
          runSaveApplication(message.tabId as number, deps),
        );
      }
      callback(undefined);
    },
  );

  const onActivated = { addListener: vi.fn(), removeListener: vi.fn() };
  const onUpdated = { addListener: vi.fn(), removeListener: vi.fn() };
  const storage = options.sessionStorage ?? fakeSessionStorage();

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn((_query: unknown, callback: (tabs: { id: number; url?: string }[]) => void) =>
        callback([{ id: options.tabId ?? 1, url: options.tabUrl ?? undefined }]),
      ),
      get: vi.fn((tabId: number, callback: (tab: { id: number; url?: string }) => void) =>
        callback({ id: tabId, url: options.tabUrl ?? undefined }),
      ),
      onActivated,
      onUpdated,
    },
    runtime: { sendMessage, openOptionsPage },
    storage,
  });

  // Both the panel and the Analysis Step read the content script's detection out of the store, so
  // seed it through the store's own entry point rather than writing its layout by hand here.
  // Awaited: the panel reads detection on mount, and an unawaited seed loses that race.
  if (options.jobPageData) {
    await reportDetectedPage(options.tabId ?? 1, 0, options.jobPageData);
  }

  return {
    openOptionsPage,
    sendMessage,
    onActivated,
    onUpdated,
    sessionStorage: storage,
    resolveFill: releaseFill,
  };
}

/**
 * Pastes a job description and clicks "Analyze".
 *
 * Pasting is part of the action now: nothing is scraped from the page, so the button stays disabled
 * until the candidate supplies the posting themselves.
 */
async function clickAnalyze(jobDescription = JOB_DESCRIPTION) {
  const textarea = await screen.findByPlaceholderText(/paste the job description/i);
  fireEvent.change(textarea, { target: { value: jobDescription } });
  fireEvent.click(await screen.findByRole('button', { name: 'Analyze' }));
}

/** Filters `sendMessage` mock calls down to a given `TypedMessage` type, e.g. `'START_ANALYSIS'`. */
function callsOfType(sendMessage: ReturnType<typeof vi.fn>, type: string) {
  return sendMessage.mock.calls.filter(([message]) => message?.type === type);
}

describe('panel App', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(callBackend).mockReset();
    vi.mocked(callBackendBinary).mockReset();
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
    const { openOptionsPage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile: null,
    });

    render(<App />);

    await screen.findByText('Set up your profile to get started.');
    fireEvent.click(screen.getByRole('button', { name: 'Open profile settings' }));
    expect(openOptionsPage).toHaveBeenCalled();
  });

  it('shows a paste box and an "Analyze" button immediately on open, even before/without any job page being detected', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://example.com',
      profile,
      jobPageData: null,
    });

    render(<App />);

    await screen.findByRole('button', { name: 'Analyze' });
    expect(screen.getByPlaceholderText(/paste the job description/i)).toBeInTheDocument();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
  });

  it('leaves the paste box empty even when a form is detected, and keeps Analyze disabled until something is pasted', async () => {
    // Detecting the form says nothing about the posting: the application page is a different page
    // from the job ad, which is why the scrape it used to be pre-filled from was dropped.
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Analyze' })).toBeDisabled();
    expect(screen.getByPlaceholderText(/paste the job description/i)).toHaveValue('');
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
  });

  it('keeps Analyze disabled when Chrome has not exposed the active tab URL', async () => {
    const { sendMessage } = await stubChrome({ tabUrl: null, profile, jobPageData: null });

    render(<App />);
    const textarea = await screen.findByPlaceholderText(/paste the job description/i);
    fireEvent.change(textarea, { target: { value: JOB_DESCRIPTION } });

    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
  });

  it("analyzes pasted text even when no job page was ever detected on the page, so pasting doesn't depend on auto-detection succeeding", async () => {
    const { sendMessage } = await stubChrome({
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
        jobDescription: 'Pasted job description text.',
        force: false,
      },
      expect.any(Function),
    );
  });

  it('disables "Analyze" when there is nothing to analyze yet (no paste, no detected job page)', async () => {
    await stubChrome({ tabUrl: 'https://example.com', profile, jobPageData: null });

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('sends the pasted job description with START_ANALYSIS', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      tabId: 1,
      profile,
      jobPageData,
    });

    render(<App />);
    await screen.findByRole('button', { name: 'Analyze' });

    await clickAnalyze('Pasted job description text.');

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'START_ANALYSIS',
        jobDescription: 'Pasted job description text.',
      }),
      expect.any(Function),
    );
  });

  it('shows an editable review once analysis succeeds', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();

    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill form' })).toBeInTheDocument();
  });

  it('reveals a job-description editor holding the analyzed text when "Edit job description" is clicked on the review screen', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));

    expect(screen.getByDisplayValue(JOB_DESCRIPTION)).toBeInTheDocument();
  });

  it('disables "Re-analyze" when the review-screen editor is cleared to empty, rather than silently analyzing blank text', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    fireEvent.change(screen.getByDisplayValue(JOB_DESCRIPTION), { target: { value: '' } });

    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeDisabled();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1);
  });

  it('re-analyzes with the manually-edited job description text from the review screen', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    fireEvent.change(screen.getByDisplayValue(JOB_DESCRIPTION), {
      target: { value: 'Pasted job description text.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(2));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[1][0]).toMatchObject({
      jobDescription: 'Pasted job description text.',
    });
  });

  it('shows an error and retries analysis when the user clicks "Try again"', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      analysisFailures: ['backend unreachable', null],
    });

    render(<App />);
    await clickAnalyze();

    await screen.findByText('Something went wrong analyzing this job posting.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Senior Engineer at Acme');
  });

  it('stops on a job already applied to, naming when it was applied for', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      existingApplications: [
        {
          id: 'application-1',
          company: 'Acme',
          roleTitle: 'Senior Engineer',
          createdAt: '2026-08-03T10:00:00.000Z',
        },
      ],
    });

    render(<App />);
    await clickAnalyze();

    await screen.findByText(/you already applied to this job on august 3, 2026/i);
    // The review never appears — the point of the guard is that no analysis ran at all.
    expect(screen.queryByRole('button', { name: 'Edit job description' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze and apply anyway' }));

    await screen.findByText('Senior Engineer at Acme');
    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(2));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[1][0]).toMatchObject({ force: true });
  });

  it('says how many times a repeatedly-applied-to job was applied for', async () => {
    const application = { id: 'a', company: 'Acme', roleTitle: 'Senior Engineer' };
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      existingApplications: [
        { ...application, createdAt: '2026-08-03T10:00:00.000Z' },
        { ...application, createdAt: '2026-07-02T10:00:00.000Z' },
      ],
    });

    render(<App />);
    await clickAnalyze();

    // A single date would hide the repeat entirely.
    await screen.findByText(
      /already applied to this job 2 times, most recently on august 3, 2026/i,
    );
  });

  it('shows the underlying cause of a failed analysis, not just a generic message', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      analysisFailures: [
        'POST /answer-questions failed (500): report_answers did not produce a tool call.',
      ],
    });

    render(<App />);
    await clickAnalyze();

    await screen.findByText('Something went wrong analyzing this job posting.');
    expect(
      screen.getByText(
        'POST /answer-questions failed (500): report_answers did not produce a tool call.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the underlying cause of a failed fill', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      saveFailures: ['POST /applications failed (500): db unreachable'],
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save application' }));

    await screen.findByText('POST /applications failed (500): db unreachable');
  });

  it('fills the form without saving until "Save application" is clicked', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/Save the application when you're ready/);
    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'START_FILL', tabId: 1, profile },
      expect.any(Function),
    );
    expect(callsOfType(sendMessage, 'START_SAVE_APPLICATION')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Save application' }));
    await screen.findByText('Application saved.');
    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'START_SAVE_APPLICATION', tabId: 1 },
      expect.any(Function),
    );
  });

  it('keeps the drafted answers, resume preview and job-description editor available after a successful fill', async () => {
    // Filling is rarely the end of the task — the page's own validation can reject a value, or an
    // answer can simply read badly once it's sitting in the form. Tearing the review down on
    // success stranded the user with a green check and no route back to the content short of
    // re-running the whole Analysis Step.
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));
    await screen.findByText(/Save the application when you're ready/);

    expect(screen.getByText('Why do you want to work here?')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview tailored resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit job description' })).toBeInTheDocument();
  });

  it('lets the user edit an answer after filling and fill again, sending the edit to the Fill Step', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));
    await screen.findByText(/Save the application when you're ready/);

    fireEvent.change(screen.getByDisplayValue('Draft answer.'), {
      target: { value: 'Revised answer.' },
    });

    const refill = await screen.findByRole('button', { name: 'Fill form again' });
    fireEvent.click(refill);

    await screen.findByText(/Save the application when you're ready/);
    expect(screen.getByDisplayValue('Revised answer.')).toBeInTheDocument();
    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === 'START_FILL'),
    ).toHaveLength(2);
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
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData: { ...jobPageData, fields: [...jobPageData.fields, unresolvedField] },
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/didn't take a value/);
    expect(screen.getByText('Referral code')).toBeInTheDocument();
    expect(screen.queryByText(/Filled 3 fields/)).not.toBeInTheDocument();
  });

  it('reports a fill that wrote nothing as a failure, not as a success with an empty warning list', async () => {
    // The pasted-job-description path can reach the Fill Step with no detected fields at all. Every
    // step then "succeeds" having done nothing, `unresolvedRequiredFields` filters an empty array
    // to an empty array, and the panel used to render an unqualified green check over an untouched
    // form — the reason this failure mode went unreported for so long.
    await stubChrome({
      tabUrl: 'https://jobs.ashbyhq.com/outset/55d672a5/application',
      profile,
      // The pasted-text path: a job description analyzed with no detected form behind it.
      jobPageData: { ...jobPageData, fields: [] },
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/no form fields were found on this page/);
    expect(screen.getByText('No form found')).toBeInTheDocument();
    expect(screen.queryByText(/saved the application\./)).not.toBeInTheDocument();
  });

  it('distinguishes a form it never found from one that kept nothing it was given', async () => {
    // Both are zero fields written, and they used to share one banner telling the user to reload
    // the page. That advice is wrong here: the form was detected perfectly well and the *page*
    // rejected every write, so reloading changes nothing and the reload advice sends the user
    // after the wrong problem.
    await stubChrome({
      tabUrl: 'https://jobs.lever.co/acme/1/apply',
      profile,
      jobPageData,
      pageKeepsNothing: true,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/kept none of the values written into it/);
    expect(screen.getByText('Nothing filled')).toBeInTheDocument();
    expect(screen.queryByText(/no form fields were found on this page/)).not.toBeInTheDocument();
  });

  it('warns when no frame answered instead of rendering a confident success', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      pageDoesNotAnswer: true,
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/fill could not be verified because this page did not answer/i);
    expect(screen.getByText('Fill unverified')).toBeInTheDocument();
    expect(screen.queryByText(/Save the application when you're ready/)).not.toBeInTheDocument();
  });

  it('ignores extra clicks on "Fill form" while a fill is already in flight', async () => {
    const { sendMessage, resolveFill } = await stubChrome({
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
    await screen.findByText(/Save the application when you're ready/);
  });

  it('shows an error and retries filling when the user clicks "Try again"', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      saveFailures: ['backend unreachable', null],
    });

    render(<App />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save application' }));

    await screen.findByText('Something went wrong saving the application.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Application saved.');
  });

  it('resets to the bootstrap screen when the active tab changes, so the panel (which survives tab switches) never shows a stale review for the previous tab', async () => {
    const { onActivated } = await stubChrome({
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
    const sessionStorage = fakeSessionStorage();
    await stubChrome({
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
    // Wait for the edit to reach the store, or reopening races the write it's meant to restore.
    await vi.waitFor(async () =>
      expect((await getPipelineRun(1))?.answers[0].answer).toBe('Edited answer.'),
    );
    first.unmount(); // simulates the panel closing

    const { sendMessage: secondSendMessage } = await stubChrome({
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
    const sessionStorage = fakeSessionStorage();
    await stubChrome({
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

    // Simulates background/applicationPipeline.ts patching the store directly, independent of this
    // mounted panel's own writes.
    await patchPipelineRun(1, {
      answers: [{ ...answers[0], answer: 'Updated from elsewhere.' }],
    });

    await screen.findByDisplayValue('Updated from elsewhere.');
  });

  it('shows a "Preview tailored resume" button on the review screen once analysis succeeds', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    expect(screen.getByRole('button', { name: 'Preview tailored resume' })).toBeInTheDocument();
  });

  it('renders the tailored resume PDF in a preview when "Preview tailored resume" is clicked', async () => {
    vi.mocked(callBackendBinary).mockResolvedValue(new Uint8Array([37, 80, 68, 70]).buffer);
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));

    const frame = await screen.findByTitle('Tailored resume');
    expect(frame).toHaveAttribute('src', 'blob:resume-preview');
    expect(callBackendBinary).toHaveBeenCalledWith('/render-resume-pdf', {
      profile,
      tailoredResume,
    });
  });

  it('shows an error message when the resume PDF fails to render', async () => {
    vi.mocked(callBackendBinary).mockRejectedValue(new Error('render failed'));
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));

    await screen.findByText(/couldn't render/i);
  });
});
