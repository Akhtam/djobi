import { EXTRACTION_VERSION } from '@djobi/shared';
import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
import type { JobPageData } from '../lib/messages';
import { reportDetectedPage } from '../lib/tabStore/detectedPage';
import { type PipelineStatus } from '../lib/run';
import { getPipelineRun, patchPipelineRun } from '../lib/tabStore/pipelineRun';
import type { BackendClient } from '../lib/backendClient';
import { HttpError } from '../lib/callBackend';
import type { FillPageCommand, PageClient } from '../lib/pageClient';
import { recordReport } from './detectedFields';
import {
  productionDetection,
  runAnalysis,
  runFill,
  runSaveApplication,
  type DetectedFieldsPort,
  type PipelineDeps,
} from './applicationPipeline';
import { jobInfo, profile, tailoredResume } from '../lib/testFixtures';

/**
 * Every test here goes through `runAnalysis`/`runFill`/`runSaveApplication` and reads the result out
 * of the store, rather than asserting on a returned value — a step and the checkpointing that drives
 * it are one module, and testing them apart asserts the same outcome twice.
 *
 * Dependencies are passed in rather than `vi.mock`ed: the seam is a parameter, so a test needn't
 * reach around the module to replace what it calls. The two tests at the bottom deliberately don't
 * pass any, exercising the real adapter — that's where the wire encoding lives.
 */

const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/1';
const EARLIER = '2026-07-02T10:00:00.000Z';
const LATER = '2026-08-03T10:00:00.000Z';

const questionField: DetectedField = {
  id: 'f-why',
  label: 'Why do you want to work here?',
  inputType: 'textarea',
  selector: '#why-field',
  category: 'question',
  // Required, because only a required question is drafted — see the optional-question case below.
  required: true,
  elementRole: 'native',
};

const emailField: DetectedField = {
  id: 'f-email',
  label: 'Email',
  inputType: 'email',
  selector: '#email-field',
  category: 'email',
  required: false,
  elementRole: 'native',
};

const resumeField: DetectedField = {
  id: 'f-resume',
  label: 'Resume',
  inputType: 'file',
  selector: '#resume-field',
  category: 'resume_upload',
  required: true,
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

const pdfBytes = new Uint8Array([37, 80, 68, 70]);

/**
 * The shared in-memory `chrome.storage.session`, plus the `chrome.tabs` the real adapter uses.
 *
 * `scanReply` is what a `SCAN_PAGE` command gets back — `undefined` standing for the tab with no
 * content script to answer it, which is how the runtime reports that (an unanswered message
 * invokes the callback with no argument and sets `runtime.lastError`).
 */
function stubChrome(scanReply?: JobPageData) {
  // The callback is the *last* argument, not the third: `chrome.tabs.sendMessage` takes an optional
  // options bag before it, and `lib/pageClient.ts` supplies `{ frameId }` whenever the frame holding
  // the form is known. A stub hard-coded to the three-argument shape never invokes the callback in
  // that case, so every command hangs unanswered.
  const tabsSendMessage = vi.fn(
    (
      _tabId: number,
      message: { type: string; values?: Record<string, string>; resumeFile?: unknown },
      ...rest: unknown[]
    ) => {
      const callback = rest[rest.length - 1] as (r: unknown) => void;
      return callback(
        message.type === 'SCAN_PAGE'
          ? scanReply
          : {
              ok: true,
              filledFieldIds: Object.keys(message.values ?? {}),
              resumeAttached: message.resumeFile !== undefined,
            },
      );
    },
  );

  vi.stubGlobal('chrome', {
    storage: fakeSessionStorage(),
    tabs: { sendMessage: tabsSendMessage },
    runtime: { lastError: undefined },
  });

  return { tabsSendMessage };
}

/**
 * A fake answer that settles on a later tick and **rejects the moment its `AbortSignal` fires**.
 *
 * `mockResolvedValue` cannot express the only interesting thing about a cancellable call: that it
 * is still outstanding when something aborts it. Every fake below used to resolve regardless of its
 * signal, so the pipeline's abort paths never ran in this suite — and a Fill/Analyze ordering bug
 * that wedged a run at `analyzing` in production kept a race test green here for a year. A fake
 * that ignores the one input the code under test passes it is not a fake of that call.
 */
function cancellable<T>(value: T) {
  return (...args: unknown[]): Promise<T> => {
    const signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
    return new Promise<T>((resolve, reject) => {
      const abort = () =>
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort);
      setTimeout(() => resolve(value), 0);
    });
  };
}

/**
 * A fake for each collaborator. Overrides are flat — `makeDeps({ scan: … })` — since a test only
 * ever wants to replace one behaviour, and naming which of the two objects it belongs to is noise.
 *
 * The five calls the pipeline hands a signal to are {@link cancellable}; the two write calls are
 * not, because the Save Step is deliberately not cancellable (`background/runClaim.ts`).
 */
function makeDeps(
  overrides: Partial<BackendClient> & Partial<PageClient> & Partial<DetectedFieldsPort> = {},
): PipelineDeps & { backend: BackendClient; page: PageClient; detection: DetectedFieldsPort } {
  const backend: BackendClient = {
    extractJob: vi.fn(cancellable(jobInfo)),
    tailorResume: vi.fn(cancellable(tailoredResume)),
    answerQuestions: vi.fn(cancellable(answers)),
    renderResumePdf: vi.fn(cancellable(pdfBytes.buffer)),
    // The Ask tab's route, likewise never reached from the pipeline.
    answerChat: vi.fn().mockResolvedValue({ reply: 'unused' }),
    // The Profile routes are the panel's and options page's, not the pipeline's — present because
    // the fake has to satisfy the whole interface, never called from here.
    getProfile: vi.fn().mockResolvedValue(null),
    saveProfile: vi.fn().mockResolvedValue(undefined),
    extractResume: vi.fn().mockResolvedValue(undefined),
    saveApplication: vi.fn().mockResolvedValue({ id: 'application-1' }),
    updateApplication: vi.fn().mockResolvedValue({ id: 'application-1' }),
    // No past application for this URL by default, so the duplicate guard lets every other test
    // through untouched.
    findApplicationDuplicates: vi.fn(cancellable({ count: 0, latest: null })),
    // Auth routes, likewise never reached from the pipeline — present only to satisfy the interface.
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
  const page: PageClient = {
    fill: vi.fn().mockImplementation((_tabId: number, command: FillPageCommand) =>
      Promise.resolve({
        ok: true as const,
        filledFieldIds: Object.keys(command.values),
        resumeAttached: command.resume !== undefined,
      }),
    ),
    // The frame is alive by default but contributes no fresher fields, so the step keeps the run's
    // own detection while preserving its addressed target. Tests for an absent/stale frame return
    // `null` explicitly.
    scan: vi.fn().mockResolvedValue({ fields: [] }),
  };
  // The real adapter by default — a test that seeds fields via `reportDetectedPage` needs the real
  // read behind it, and this suite has several that address a specific frame or wait on enrichment
  // through the full pipeline rather than through `detectedFields.test.ts`'s own focused suite. A
  // test that wants no storage interaction at all overrides one or both methods explicitly.
  const detection: DetectedFieldsPort = { ...productionDetection };

  for (const [key, value] of Object.entries(overrides)) {
    if (key in backend) Object.assign(backend, { [key]: value });
    else if (key in page) Object.assign(page, { [key]: value });
    else Object.assign(detection, { [key]: value });
  }

  return { backend, page, detection };
}

/** Detects `fields` on `tabId` and analyzes it, leaving a run in `review` ready for the Fill Step. */
async function seedReviewRun(
  tabId: number,
  fields: DetectedField[],
  tabUrl: string | null = 'https://boards.greenhouse.io/acme/jobs/1',
) {
  await reportDetectedPage(tabId, 0, { fields });
  await runAnalysis(tabId, tabUrl, profile, 'Senior Engineer at Acme...', makeDeps());
}

describe('runAnalysis', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops before LLM calls when a stale duplicate-check result cannot patch its run', async () => {
    stubChrome();
    let resolveDuplicates!: (value: { count: number; latest: null }) => void;
    const duplicates = new Promise<{ count: number; latest: null }>((resolve) => {
      resolveDuplicates = resolve;
    });
    const staleDeps = makeDeps({
      findApplicationDuplicates: vi.fn(() => duplicates),
    });
    const staleAnalysis = runAnalysis(7, JOB_URL, profile, 'Old posting', staleDeps);
    await vi.waitFor(() =>
      expect(staleDeps.backend.findApplicationDuplicates).toHaveBeenCalledTimes(1),
    );

    await runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps(), true);
    resolveDuplicates({ count: 0, latest: null });
    await staleAnalysis;

    expect(staleDeps.backend.extractJob).not.toHaveBeenCalled();
    expect(staleDeps.backend.tailorResume).not.toHaveBeenCalled();
    expect(staleDeps.backend.answerQuestions).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ jobDescription: 'New posting' });
  });

  it('starts the duplicate lookup while the enriched field snapshot is still pending', async () => {
    stubChrome();
    let releaseOracle!: () => void;
    const oracleGate = new Promise<void>((resolve) => {
      releaseOracle = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await oracleGate;
        return { ok: true, json: async () => ({ questions: [] }) } as unknown as Response;
      }),
    );
    const report = recordReport(7, 0, [questionField], JOB_URL);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const deps = makeDeps();

    const analysis = runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', deps);
    await vi.waitFor(() => expect(deps.backend.findApplicationDuplicates).toHaveBeenCalled());
    expect(deps.backend.extractJob).not.toHaveBeenCalled();

    releaseOracle();
    await report;
    await analysis;

    expect(deps.backend.extractJob).toHaveBeenCalled();
  });

  it('answers a screening question from the profile without asking the model at all', async () => {
    stubChrome();
    const deps = makeDeps();
    const sponsorship: DetectedField = {
      id: 'f-sponsor',
      label: 'Will you now or in the future require visa sponsorship?',
      inputType: 'radiogroup',
      selector: '#sponsor-field',
      category: 'question',
      required: true,
      elementRole: 'radiogroup',
      options: [
        { label: 'Yes, I will require sponsorship', selector: '#yes' },
        { label: 'No, I will not require sponsorship', selector: '#no' },
      ],
    };
    const prepared = { ...profile, screeningAnswers: { sponsorship_required: 'No' } };
    await reportDetectedPage(7, 0, {
      fields: [sponsorship],
    });

    await runAnalysis(7, null, prepared, 'Senior Engineer at Acme...', deps);

    // The model is asked nothing — the profile already settles this one, so no request is sent.
    expect(deps.backend.answerQuestions).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({
      answers: [
        {
          fieldId: 'f-sponsor',
          question: 'Will you now or in the future require visa sponsorship?',
          // Mapped onto the form's own wording, so `fillForm` can find the option to click.
          answer: 'No, I will not require sponsorship',
          sourceStoryIds: [],
        },
      ],
    });
  });

  it("hands a screening question the profile knows but can't map to the model, carrying the fact", async () => {
    stubChrome();
    const deps = makeDeps();
    const sponsorship: DetectedField = {
      id: 'f-sponsor',
      label: 'Will you require sponsorship?',
      inputType: 'radiogroup',
      selector: '#sponsor-field',
      category: 'question',
      required: true,
      elementRole: 'radiogroup',
      options: [
        { label: 'I have unrestricted work rights', selector: '#a' },
        { label: 'I need employer support', selector: '#b' },
      ],
    };
    const prepared = { ...profile, screeningAnswers: { sponsorship_required: 'No' } };
    await reportDetectedPage(7, 0, {
      fields: [sponsorship],
    });

    await runAnalysis(7, null, prepared, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(
      prepared,
      jobInfo,
      [
        {
          fieldId: 'f-sponsor',
          question: 'Will you require sponsorship?',
          options: ['I have unrestricted work rights', 'I need employer support'],
          knownAnswer: 'No',
        },
      ],
      expect.any(AbortSignal),
    );
  });

  it('drafts only the required questions, leaving an optional one to the candidate', async () => {
    // Drafting is the slowest call in the Analysis Step and its cost is per question, so an
    // optional box — one the candidate can simply leave empty — is not worth the wait.
    stubChrome();
    const deps = makeDeps();
    const optional: DetectedField = {
      id: 'f-extra',
      label: 'Anything else you would like us to know?',
      inputType: 'textarea',
      selector: '#extra-field',
      category: 'question',
      required: false,
      elementRole: 'native',
    };
    await reportDetectedPage(7, 0, { fields: [questionField, optional] });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(
      profile,
      jobInfo,
      [{ fieldId: 'f-why', question: 'Why do you want to work here?' }],
      expect.any(AbortSignal),
    );
  });

  it('still fills an optional question the profile already answers, which costs no model call', async () => {
    stubChrome();
    const deps = makeDeps();
    const optional: DetectedField = {
      id: 'f-country',
      label: 'What country are you based in?',
      inputType: 'text',
      selector: '#country-field',
      category: 'question',
      required: false,
      elementRole: 'native',
    };
    const prepared = {
      ...profile,
      customAnswers: [{ question: 'What country are you based in?', answer: 'USA' }],
    };
    await reportDetectedPage(7, 0, { fields: [optional] });

    await runAnalysis(7, null, prepared, 'Senior Engineer at Acme...', deps);

    // Not called at all: with nothing left to draft, the Analysis Step spends no request finding out.
    expect(deps.backend.answerQuestions).not.toHaveBeenCalled();
    const run = await getPipelineRun(7);
    expect(run?.answers).toEqual([
      {
        fieldId: 'f-country',
        question: 'What country are you based in?',
        answer: 'USA',
        sourceStoryIds: [],
      },
    ]);
  });

  it("sends an optional question the profile knows but can't map, which costs no model call", async () => {
    // The required-only filter is about model calls, and this question needs none: `answerQuestions`
    // maps the stated fact onto the form's options itself. Dropped here, an optional question the
    // candidate has already answered would simply be left blank.
    stubChrome();
    const deps = makeDeps();
    const sponsorship: DetectedField = {
      id: 'f-sponsor',
      label: 'Will you require sponsorship?',
      inputType: 'radiogroup',
      selector: '#sponsor-field',
      category: 'question',
      required: false,
      elementRole: 'radiogroup',
      options: [
        { label: 'I have unrestricted work rights', selector: '#a' },
        { label: 'I need employer support', selector: '#b' },
      ],
    };
    const prepared = { ...profile, screeningAnswers: { sponsorship_required: 'No' } };
    await reportDetectedPage(7, 0, { fields: [sponsorship] });

    await runAnalysis(7, null, prepared, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(
      prepared,
      jobInfo,
      [
        {
          fieldId: 'f-sponsor',
          question: 'Will you require sponsorship?',
          options: ['I have unrestricted work rights', 'I need employer support'],
          knownAnswer: 'No',
        },
      ],
      expect.any(AbortSignal),
    );
  });

  it("keeps prepared and drafted answers in the page's own field order, not prepared-first", async () => {
    stubChrome();
    const deps = makeDeps();
    const sponsorship: DetectedField = {
      id: 'f-sponsor',
      label: 'Will you require visa sponsorship?',
      inputType: 'text',
      selector: '#sponsor-field',
      category: 'question',
      required: false,
      elementRole: 'native',
    };
    const prepared = { ...profile, screeningAnswers: { sponsorship_required: 'No' } };
    await reportDetectedPage(7, 0, {
      // The drafted question comes first on the page; the prepared one second.
      fields: [questionField, sponsorship],
    });

    await runAnalysis(7, null, prepared, 'Senior Engineer at Acme...', deps);

    const run = await getPipelineRun(7);
    expect(run?.answers.map((answer) => answer.fieldId)).toEqual(['f-why', 'f-sponsor']);
  });

  it('extracts job info, tailors a resume and drafts answers from it, then checkpoints the results into tabStore', async () => {
    stubChrome();
    const deps = makeDeps();
    await reportDetectedPage(7, 0, {
      fields: [questionField],
    });

    await runAnalysis(
      7,
      'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      'Senior Engineer at Acme...',
      deps,
    );

    expect(deps.backend.extractJob).toHaveBeenCalledWith(
      'Senior Engineer at Acme...',
      expect.any(AbortSignal),
    );
    expect(deps.backend.tailorResume).toHaveBeenCalledWith(
      profile,
      jobInfo,
      expect.any(AbortSignal),
    );
    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(
      profile,
      jobInfo,
      [{ fieldId: 'f-why', question: 'Why do you want to work here?' }],
      expect.any(AbortSignal),
    );
    expect(await getPipelineRun(7)).toEqual({
      runId: expect.any(String),
      status: 'review',
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      jobPageData: { fields: [questionField] },
      jobDescription: 'Senior Engineer at Acme...',
      analyzedJobDescription: 'Senior Engineer at Acme...',
      jobInfo,
      tailoredResume,
      answers,
      coverage: [],
      unresolvedRequiredFields: [],
      filledFieldCount: 0,
      fillOutcome: null,
      applicationId: null,
      failure: null,
      duplicateOf: null,
    });
  });

  it('checkpoints what the tailored resume evidences of the posting keywords, so the panel reports the resume this run produced', async () => {
    stubChrome();
    const bullet = 'Migrated the fleet to Kubernetes';
    const deps = makeDeps();
    deps.backend.extractJob = vi.fn().mockResolvedValue({
      ...jobInfo,
      keywords: [
        { term: 'Kubernetes', category: null },
        { term: 'Terraform', category: null },
      ],
    });
    deps.backend.tailorResume = vi.fn().mockResolvedValue({
      skills: [],
      workExperience: [
        { company: 'Acme', title: 'Engineer', startDate: '2020', endDate: null, bullets: [bullet] },
      ],
    });
    await reportDetectedPage(7, 0, { fields: [questionField] });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect((await getPipelineRun(7))?.coverage).toEqual([
      { keyword: 'Kubernetes', verdict: 'experience', evidence: bullet },
      { keyword: 'Terraform', verdict: 'missing', evidence: null },
    ]);
  });

  it("passes only a question field's option labels to answerQuestions — the DOM selector that locates each choice is meaningless off-page and never crosses the seam", async () => {
    stubChrome();
    const deps = makeDeps();
    const comboboxField: DetectedField = {
      id: 'f-auth',
      label: 'Are you authorized to work in the US?',
      inputType: 'combobox',
      selector: '#auth-field',
      category: 'question',
      required: true,
      elementRole: 'combobox',
      options: [
        { label: 'Yes', selector: '#opt-yes' },
        { label: 'No', selector: '#opt-no' },
      ],
    };
    await reportDetectedPage(7, 0, {
      fields: [comboboxField],
    });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(
      profile,
      jobInfo,
      [
        {
          fieldId: 'f-auth',
          question: 'Are you authorized to work in the US?',
          options: ['Yes', 'No'],
        },
      ],
      expect.any(AbortSignal),
    );
  });

  it('checkpoints "analyzing" before the first call, so the panel has something to render while it waits', async () => {
    stubChrome();
    await reportDetectedPage(7, 0, { fields: [] });
    const deps = makeDeps({
      extractJob: vi.fn(async () => {
        expect(await getPipelineRun(7)).toMatchObject({ status: 'analyzing' });
        return jobInfo;
      }),
    });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.extractJob).toHaveBeenCalled();
  });

  it('checkpoints "analyze-error" when a call fails, instead of throwing to a caller that may no longer be listening', async () => {
    stubChrome();
    await reportDetectedPage(7, 0, { fields: [] });
    const deps = makeDeps({
      extractJob: vi.fn().mockRejectedValue(new Error('backend unreachable')),
    });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect(await getPipelineRun(7)).toMatchObject({ status: 'analyze-error' });
  });

  it("checkpoints the safe backend classification alongside 'analyze-error'", async () => {
    stubChrome();
    // A required question, so the drafting call is actually made and can be the one that fails.
    await reportDetectedPage(7, 0, { fields: [questionField] });
    const deps = makeDeps({
      answerQuestions: vi
        .fn()
        .mockRejectedValue(
          new HttpError(
            'http',
            '/answer-questions',
            'POST /answer-questions failed (500): report_answers did not produce a tool call.',
            500,
            { backendCode: 'invalid-model-output' },
          ),
        ),
    });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'analyze-error',
      failure: {
        step: 'analysis',
        kind: 'invalid-model-output',
      },
    });
  });

  it('checkpoints a storage failure after claiming analysis, including work that happens before the backend calls', async () => {
    stubChrome();
    const originalGet = chrome.storage.session.get.bind(chrome.storage.session);
    let reads = 0;
    chrome.storage.session.get = vi.fn((keys) => {
      reads += 1;
      if (reads === 2) return Promise.reject(new Error('session read failed'));
      return originalGet(keys);
    }) as typeof chrome.storage.session.get;

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', makeDeps());

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'analyze-error',
      failure: { step: 'analysis', kind: 'unknown' },
    });
  });

  it('rejects to the terminal observer when both analysis and its failure checkpoint fail', async () => {
    stubChrome();
    const originalGet = chrome.storage.session.get.bind(chrome.storage.session);
    let reads = 0;
    chrome.storage.session.get = vi.fn((keys) => {
      reads += 1;
      if (reads === 4) return Promise.reject(new Error('checkpoint storage failed'));
      return originalGet(keys);
    }) as typeof chrome.storage.session.get;
    const analysisFailure = new Error('backend unavailable');

    const rejected = runAnalysis(
      7,
      null,
      profile,
      'Senior Engineer at Acme...',
      makeDeps({ extractJob: vi.fn().mockRejectedValue(analysisFailure) }),
    );

    await expect(rejected).rejects.toMatchObject({
      message: 'analysis failed and its failure could not be stored',
      errors: [analysisFailure, expect.objectContaining({ message: 'checkpoint storage failed' })],
    });
  });

  it('clears a previous failure when a fresh analysis starts, so a stale reason never outlives the run that produced it', async () => {
    stubChrome();
    await reportDetectedPage(7, 0, { fields: [] });
    await runAnalysis(
      7,
      null,
      profile,
      'Senior Engineer at Acme...',
      makeDeps({ extractJob: vi.fn().mockRejectedValue(new Error('backend unreachable')) }),
    );
    expect(await getPipelineRun(7)).toMatchObject({ failure: { step: 'analysis' } });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', makeDeps());

    expect(await getPipelineRun(7)).toMatchObject({ status: 'review', failure: null });
  });

  it('analyzes pasted text with no fields when no job page was ever detected for the tab', async () => {
    stubChrome();

    await runAnalysis(9, null, profile, 'Pasted job description text.', makeDeps());

    expect(await getPipelineRun(9)).toMatchObject({
      jobPageData: { fields: [] },
    });
  });

  it('stops on a job URL already applied to, before spending a single backend call', async () => {
    stubChrome();
    const deps = makeDeps({
      findApplicationDuplicates: vi.fn().mockResolvedValue({
        count: 2,
        latest: {
          id: 'application-2',
          company: 'Acme',
          roleTitle: 'Senior Engineer',
          stage: 'onsite',
          createdAt: LATER,
        },
      }),
    });

    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.findApplicationDuplicates).toHaveBeenCalledWith(
      JOB_URL,
      expect.any(AbortSignal),
    );
    expect(deps.backend.extractJob).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'duplicate',
      // The most recent save, and how many there have been — one date alone would hide that the
      // candidate has applied to this posting more than once.
      duplicateOf: { id: 'application-2', createdAt: LATER, count: 2 },
    });
  });

  it('analyzes a job URL already applied to when the candidate insists', async () => {
    stubChrome();
    const deps = makeDeps({
      findApplicationDuplicates: vi.fn().mockResolvedValue({
        count: 1,
        latest: {
          id: 'application-1',
          company: 'Acme',
          roleTitle: 'X',
          stage: 'applied',
          createdAt: LATER,
        },
      }),
    });

    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', deps, true);

    // Not even asked: forcing means the answer cannot change anything.
    expect(deps.backend.findApplicationDuplicates).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status: 'review', duplicateOf: null });
  });

  it('analyzes anyway when the duplicate check itself fails, and says so once', async () => {
    // The guard is advisory — a backend that isn't running must not be why Analyze stops working.
    // Swallowed, but not silently: the warning is the only trace that the candidate went unwarned.
    stubChrome();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deps = makeDeps({
      findApplicationDuplicates: vi.fn().mockRejectedValue(new Error('backend unreachable')),
    });

    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', deps);

    expect(await getPipelineRun(7)).toMatchObject({ status: 'review', duplicateOf: null });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('duplicate check failed, continuing without it: backend unreachable'),
    );
    warn.mockRestore();
  });

  /**
   * The one failure the Duplicate Guard does *not* swallow. It fails open so a backend that can't
   * answer never stops the candidate — but a cancellation is not the lookup failing, it is this run
   * being superseded, and reading it as "no duplicates" would send a run the candidate replaced on
   * to spend the model calls the guard exists to save.
   */
  it('does not read a superseded duplicate lookup as "no duplicates" and carry on', async () => {
    stubChrome();
    let releaseLookup!: () => void;
    const lookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const staleDeps = makeDeps({
      findApplicationDuplicates: vi.fn((_jobUrl: string, signal?: AbortSignal) =>
        lookup.then(() => {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          return { count: 0, latest: null };
        }),
      ),
    });

    const stale = runAnalysis(7, JOB_URL, profile, 'Old posting', staleDeps);
    await vi.waitFor(() => expect(staleDeps.backend.findApplicationDuplicates).toHaveBeenCalled());
    await runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps(), true);
    releaseLookup();
    await stale;

    expect(staleDeps.backend.extractJob).not.toHaveBeenCalled();
    // The newer run owns the tab, and the superseded one reported nothing over it.
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'review',
      jobDescription: 'New posting',
      failure: null,
    });
  });

  it('skips the check when Chrome never exposed a URL for the tab', async () => {
    stubChrome();
    const deps = makeDeps();

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.findApplicationDuplicates).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status: 'review' });
  });

  it('does nothing when no job description was pasted — there is nothing to analyze', async () => {
    stubChrome();
    const deps = makeDeps();

    await runAnalysis(11, null, profile, '   ', deps);

    expect(deps.backend.extractJob).not.toHaveBeenCalled();
    expect(await getPipelineRun(11)).toBeNull();
  });

  it('keeps the newer run when two analyses resolve in reverse order', async () => {
    stubChrome();
    let resolveFirst!: (value: JobInfo) => void;
    const firstExtract = new Promise<JobInfo>((resolve) => {
      resolveFirst = resolve;
    });
    const firstDeps = makeDeps({ extractJob: vi.fn(() => firstExtract) });
    const newerJobInfo = { ...jobInfo, company: 'Globex' };
    const secondDeps = makeDeps({ extractJob: vi.fn().mockResolvedValue(newerJobInfo) });

    const first = runAnalysis(7, JOB_URL, profile, 'First posting', firstDeps);
    await vi.waitFor(() => expect(firstDeps.backend.extractJob).toHaveBeenCalled());
    const firstRunId = (await getPipelineRun(7))!.runId;

    await runAnalysis(7, JOB_URL, profile, 'Second posting', secondDeps);
    const secondRun = await getPipelineRun(7);
    expect(secondRun?.runId).not.toBe(firstRunId);

    resolveFirst(jobInfo);
    await first;

    expect(await getPipelineRun(7)).toMatchObject({
      runId: secondRun!.runId,
      status: 'review',
      jobDescription: 'Second posting',
      jobInfo: newerJobInfo,
    });
  });
});

describe('runFill', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills scalar and question fields without saving the application, then checkpoints "filled"', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField, questionField]);
    const deps = makeDeps();

    await runFill(7, profile, deps);

    expect(deps.backend.renderResumePdf).not.toHaveBeenCalled();
    // The trailing `0` is the frame the form was reported from. Broadcasting instead — which this
    // used to do — lets any other frame in the tab answer first with an empty result.
    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      {
        runId: expect.any(String),
        fields: [emailField, questionField],
        values: { 'f-email': 'jane@example.com', 'f-why': 'Draft answer.' },
        resume: undefined,
      },
      0,
    );
    expect(deps.backend.saveApplication).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status: 'filled' });
  });

  it('fills the form the page holds now, not the one detected when the Analysis Step started', async () => {
    stubChrome();
    // The run was analyzed from a pasted job description before the form had rendered — the exact
    // case that used to report "nothing was filled" no matter how complete the form later became.
    await seedReviewRun(7, []);
    const deps = makeDeps({
      scan: vi.fn().mockResolvedValue({ fields: [emailField] }),
    });

    await runFill(7, profile, deps);

    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      {
        runId: expect.any(String),
        fields: [emailField],
        values: { 'f-email': 'jane@example.com' },
        resume: undefined,
      },
      0,
    );
    expect(await getPipelineRun(7)).toMatchObject({ filledFieldCount: 1 });
  });

  it('fills what it has an answer for and leaves an unanalyzed question blank for the candidate', async () => {
    stubChrome();
    await seedReviewRun(7, []);
    const deps = makeDeps({
      scan: vi.fn().mockResolvedValue({ fields: [emailField, questionField] }),
    });

    await runFill(7, profile, deps);

    // The question carries no drafted answer, so it is absent from `values` — but the scalar field
    // still lands rather than the whole fill being withheld.
    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      {
        runId: expect.any(String),
        fields: [emailField, questionField],
        values: { 'f-email': 'jane@example.com' },
        resume: undefined,
      },
      0,
    );
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'filled',
      jobPageData: { fields: [emailField, questionField] },
      answers: [],
      filledFieldCount: 1,
    });
  });

  it('matches a drafted answer onto its question by text when the ATS remounted the field and it was re-tagged', async () => {
    stubChrome();
    await seedReviewRun(7, [questionField]);
    // Same question, new id: the element was unmounted and remounted between analyzing and filling.
    const remounted: DetectedField = { ...questionField, id: 'f-why-2', selector: '#why-field-2' };
    const deps = makeDeps({
      scan: vi.fn().mockResolvedValue({ fields: [remounted] }),
    });

    await runFill(7, profile, deps);

    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ values: { 'f-why-2': 'Draft answer.' } }),
      0,
    );
  });

  it("falls back to the run's own detection when the page can't be re-scanned (no content script to answer)", async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps({ scan: vi.fn().mockResolvedValue(null) });

    await runFill(7, profile, deps);

    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ fields: [emailField] }),
      undefined,
    );
  });

  it('addresses the frame that reported the form, not every frame in the tab', async () => {
    stubChrome();
    // Frame 0 is the host page with a stray file input of its own; frame 4 holds the real form.
    // `getDetectedFrame` picks by field count, and the Fill Step has to address *that* frame — a
    // broadcast is answered by whichever frame is quickest, which is never the one doing the work.
    await reportDetectedPage(7, 0, { fields: [resumeField] });
    await reportDetectedPage(7, 4, { fields: [emailField, questionField] });
    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', makeDeps());
    const deps = makeDeps();

    await runFill(7, profile, deps);

    expect(deps.page.scan).toHaveBeenCalledWith(7, 4);
    expect(deps.page.fill).toHaveBeenCalledWith(7, expect.anything(), 4);
  });

  it('falls back to a broadcast scan and fill when navigation destroyed the stored frame', async () => {
    stubChrome();
    await reportDetectedPage(7, 4, { fields: [emailField, questionField] });
    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', makeDeps());
    const scan = vi.fn((_tabId: number, frameId?: number) =>
      Promise.resolve(frameId === 4 ? null : { fields: [emailField] }),
    );
    const deps = makeDeps({ scan });

    await runFill(7, profile, deps);

    expect(scan).toHaveBeenNthCalledWith(1, 7, 4);
    expect(scan).toHaveBeenNthCalledWith(2, 7);
    expect(deps.page.fill).toHaveBeenCalledTimes(1);
    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ fields: [emailField] }),
      undefined,
    );
  });

  it('broadcasts when no frame ever reported, since there is no frame to address', async () => {
    stubChrome();
    // The pasted-job-description path: analyzed before any form rendered, so nothing was reported.
    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', makeDeps());
    const deps = makeDeps({ scan: vi.fn().mockResolvedValue({ fields: [emailField] }) });

    await runFill(7, profile, deps);

    expect(deps.page.scan).toHaveBeenCalledWith(7, undefined);
    expect(deps.page.fill).toHaveBeenCalledWith(7, expect.anything(), undefined);
  });

  it('checkpoints the re-scanned fields onto the run, so the panel reports what was actually filled', async () => {
    stubChrome();
    await seedReviewRun(7, []);
    const required: DetectedField = { ...resumeField, category: 'unknown', label: 'Referral code' };
    const deps = makeDeps({
      scan: vi.fn().mockResolvedValue({ fields: [required] }),
    });

    await runFill(7, profile, deps);

    expect(await getPipelineRun(7)).toMatchObject({
      jobPageData: { fields: [required] },
      unresolvedRequiredFields: [required],
    });
  });

  it('checkpoints required fields that end up with no resolved value, so they don\'t silently disappear behind a "filled" status', async () => {
    const unresolvedField: DetectedField = {
      id: 'f-mystery',
      label: 'Referral code',
      inputType: 'text',
      selector: '#mystery-field',
      category: 'unknown',
      required: true,
      elementRole: 'native',
    };
    stubChrome();
    await seedReviewRun(7, [emailField, unresolvedField]);

    await runFill(7, profile, makeDeps());

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'filled',
      unresolvedRequiredFields: [unresolvedField],
    });
  });

  it("reports a required field the page didn't keep, even though a value was drafted for it", async () => {
    // The failure this exists for: the fill writes into a field the ATS's form model discards, the
    // panel shows a green check because it only ever knew what it *sent*, and the candidate finds
    // out from the ATS's own "missing entry for required field" on submit.
    stubChrome();
    const required = { ...emailField, required: true };
    await seedReviewRun(7, [required]);
    const deps = makeDeps({
      fill: vi.fn().mockResolvedValue({ ok: true, filledFieldIds: [], resumeAttached: false }),
    });

    await runFill(7, profile, deps);

    expect(await getPipelineRun(7)).toMatchObject({
      unresolvedRequiredFields: [required],
      filledFieldCount: 0,
      fillOutcome: 'nothing-filled',
    });
  });

  it('marks the fill unverified when no frame answers instead of treating drafted values as success', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps({ fill: vi.fn().mockResolvedValue(null) });

    await runFill(7, profile, deps);

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'filled',
      filledFieldCount: 1,
      fillOutcome: 'unverified',
    });
  });

  it('does not report a required field once it does resolve a value', async () => {
    stubChrome();
    await seedReviewRun(7, [{ ...emailField, required: true }]);

    await runFill(7, profile, makeDeps());

    expect(await getPipelineRun(7)).toMatchObject({ unresolvedRequiredFields: [] });
  });

  it('reports how many fields it actually wrote, counting the resume', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField, questionField, resumeField]);

    await runFill(7, profile, makeDeps());

    expect(await getPipelineRun(7)).toMatchObject({ filledFieldCount: 3 });
  });

  it('reports zero filled fields when detection found nothing, so an empty run cannot pass for a success', async () => {
    // `unresolvedRequiredFields` is derived by filtering `fields`, so it is empty here too — the
    // panel used to read that as "everything resolved" and show a green check for a run that
    // touched nothing at all.
    stubChrome();
    await reportDetectedPage(7, 0, { fields: [] });
    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', makeDeps());

    const deps = makeDeps();
    await runFill(7, profile, deps);

    expect(await getPipelineRun(7)).toMatchObject({
      filledFieldCount: 0,
      unresolvedRequiredFields: [],
      fillOutcome: 'no-fields-detected',
    });
    expect(deps.page.fill).not.toHaveBeenCalled();
  });

  it('renders the tailored resume once any resume_upload field is detected, leaving which input receives it to the content script', async () => {
    // An ATS can render several `resume_upload` inputs (Ashby pairs an unlabeled decoy with the
    // real, required one). This step only decides *whether* a resume is needed; `content/index.ts`
    // decides where it lands, and has its own regression test for that.
    const decoyField: DetectedField = {
      id: 'f-decoy',
      label: '',
      inputType: 'file',
      selector: '#decoy-field',
      category: 'resume_upload',
      required: false,
      elementRole: 'native',
    };
    stubChrome();
    await seedReviewRun(7, [decoyField, resumeField]);
    const deps = makeDeps();

    await runFill(7, profile, deps);

    expect(deps.backend.renderResumePdf).toHaveBeenCalledTimes(1);
    expect(deps.backend.renderResumePdf).toHaveBeenCalledWith(
      profile,
      tailoredResume,
      expect.any(AbortSignal),
    );
    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      {
        runId: expect.any(String),
        fields: [decoyField, resumeField],
        values: {},
        resume: { name: 'jane_doe_resume.pdf', type: 'application/pdf', bytes: pdfBytes.buffer },
      },
      0,
    );
    expect(await getPipelineRun(7)).toMatchObject({ unresolvedRequiredFields: [] });
  });

  it('does not save while filling, so a backend persistence failure cannot make the fill fail', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps({
      saveApplication: vi.fn().mockRejectedValue(new Error('backend unreachable')),
    });

    await runFill(7, profile, deps);

    expect(await getPipelineRun(7)).toMatchObject({ status: 'filled', failure: null });
  });

  it('creates an application only after an explicit save, then updates that record on later saves', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const saved = { id: 'application-1' } as never;
    const deps = makeDeps({
      saveApplication: vi.fn().mockResolvedValue(saved),
      updateApplication: vi.fn().mockResolvedValue(saved),
    });

    await runFill(7, profile, deps);
    await runSaveApplication(7, deps);

    expect(deps.backend.saveApplication).toHaveBeenCalledWith({
      company: 'Acme',
      roleTitle: 'Senior Engineer',
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      jobInfo,
      tailoredResume,
      answers: [],
      rawDescription: 'Senior Engineer at Acme...',
      extractionVersion: EXTRACTION_VERSION,
      // The default fake `getProfile()` answers `null` here, unstubbed by this case — so both
      // Profile-derived provenance fields go in null, exactly as a save whose Profile lookup failed
      // would. The case below stubs a real Profile.
      requirementEvidence: null,
      bulletProvenance: null,
    });
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'saved',
      applicationId: 'application-1',
    });

    await runFill(7, profile, deps);
    await runSaveApplication(7, deps);

    expect(deps.backend.updateApplication).toHaveBeenCalledWith(
      'application-1',
      expect.any(Object),
    );
    expect(deps.backend.saveApplication).toHaveBeenCalledTimes(1);
  });

  it('tells the candidate on the tab once the row exists, naming the job that was saved', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const announce = vi.fn();
    const deps = { ...makeDeps({}), saveNotice: { announce } };

    await runFill(7, profile, deps);
    await runSaveApplication(7, deps);

    expect(announce).toHaveBeenCalledWith(7, { company: 'Acme', roleTitle: 'Senior Engineer' });
  });

  it('announces nothing when the write failed, since there is no record to report', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const announce = vi.fn();
    const deps = {
      ...makeDeps({ saveApplication: vi.fn().mockRejectedValue(new Error('backend unreachable')) }),
      saveNotice: { announce },
    };

    await runFill(7, profile, deps);
    await runSaveApplication(7, deps);

    expect(await getPipelineRun(7)).toMatchObject({ status: 'save-error' });
    expect(announce).not.toHaveBeenCalled();
  });

  it('saves the description Analysis actually analyzed, even if the editor has since diverged', async () => {
    // A candidate may edit the job-description textarea after Analysis without clicking
    // Re-analyze — `jobDescription` tracks that edit, but `jobInfo`/`tailoredResume` still reflect
    // the original text. `rawDescription` must stay pinned to what was actually analyzed, since it
    // exists to document what produced this saved snapshot.
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const run = await getPipelineRun(7);
    await patchPipelineRun(7, run!.runId, { jobDescription: 'Edited after analysis, unanalyzed' });
    const deps = makeDeps({ saveApplication: vi.fn().mockResolvedValue({ id: 'application-1' }) });

    await runFill(7, profile, deps);
    await runSaveApplication(7, deps);

    expect(deps.backend.saveApplication).toHaveBeenCalledWith(
      expect.objectContaining({ rawDescription: 'Senior Engineer at Acme...' }),
    );
  });

  it('computes requirementEvidence/bulletProvenance from the Profile fetched fresh at save time, rather than always saving null', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps({
      getProfile: vi.fn().mockResolvedValue(profile),
      saveApplication: vi.fn().mockResolvedValue({ id: 'application-1' } as never),
    });

    await runFill(7, profile, deps);
    await runSaveApplication(7, deps);

    // The fixture Profile/Tailored Resume both carry no work experience or requirements, so the
    // honest answer here is an empty array — the point of this case is that it is `[]`, computed,
    // rather than `null`, skipped, now that a Profile was actually available.
    expect(deps.backend.saveApplication).toHaveBeenCalledWith(
      expect.objectContaining({ requirementEvidence: [], bulletProvenance: [] }),
    );
  });

  it('checkpoints a save error and allows it to be retried', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const saved = { id: 'application-1' } as never;
    const deps = makeDeps({
      saveApplication: vi
        .fn()
        .mockRejectedValueOnce(new Error('backend unreachable'))
        .mockResolvedValueOnce(saved),
    });

    await runFill(7, profile, deps);
    await runSaveApplication(7, deps);
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'save-error',
      failure: { step: 'save', kind: 'unknown' },
    });

    await runSaveApplication(7, deps);
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'saved',
      applicationId: 'application-1',
    });
  });

  it('drops a stale Fill completion after a newer analysis claims the tab', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    let resolveFill!: (value: {
      ok: true;
      filledFieldIds: string[];
      resumeAttached: false;
    }) => void;
    const fillResult = new Promise<{
      ok: true;
      filledFieldIds: string[];
      resumeAttached: false;
    }>((resolve) => {
      resolveFill = resolve;
    });
    const filling = runFill(7, profile, makeDeps({ fill: vi.fn(() => fillResult) }));
    await vi.waitFor(async () => expect((await getPipelineRun(7))?.status).toBe('filling'));

    await runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps());
    const newerRun = await getPipelineRun(7);
    resolveFill({ ok: true, filledFieldIds: [emailField.id], resumeAttached: false });
    await filling;

    expect(await getPipelineRun(7)).toMatchObject({
      runId: newerRun!.runId,
      status: 'review',
      jobDescription: 'New posting',
      fillOutcome: null,
    });
  });

  it('keeps a newer analysis authoritative when Fill and Analyze race to claim the tab', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const staleDeps = makeDeps();

    const staleFill = runFill(7, profile, staleDeps);
    const newerAnalysis = runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps(), true);
    await Promise.all([staleFill, newerAnalysis]);

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'review',
      jobDescription: 'New posting',
    });
  });

  /**
   * The ordering fix in `background/runClaim.ts`. A Fill claims its run by awaiting an atomic
   * transition; an Analyze dispatched in that gap takes the tab. Claiming the tab's cancellable
   * slot *before* winning the run — which is what the Fill Step used to do — aborted the newer
   * Analysis, whose own catch then read `signal.aborted` and returned silently, leaving the run at
   * `analyzing` with `failure: null`: a spinner with no error and no retry.
   *
   * This is the case the suite could not see until its fakes honoured their signals.
   */
  it('leaves a newer Analysis running when a Fill claims the tab in the same tick', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);

    const staleFill = runFill(7, profile, makeDeps());
    const newerAnalysis = runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps(), true);
    await Promise.all([staleFill, newerAnalysis]);

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'review',
      jobDescription: 'New posting',
      failure: null,
    });
  });

  /**
   * The same rule from the other side: a Fill that never wins the run must abort nobody. It used to
   * claim the cancellable slot first and check the run afterwards, so a Fill commanded during an
   * Analysis killed that Analysis and then declined to do anything itself.
   */
  it('does not cancel an Analysis in flight when a Fill it cannot claim arrives', async () => {
    stubChrome();
    const analysisDeps = makeDeps();
    const analysis = runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', analysisDeps);

    const fillDeps = makeDeps();
    await runFill(7, profile, fillDeps);
    await analysis;

    expect(fillDeps.page.fill).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status: 'review', failure: null });
  });

  /**
   * `START_FILL` names the run the panel meant. Delivery can be delayed past a re-analysis, and a
   * command that claims whichever run happens to be current by then fills a different posting's
   * form with a different posting's answers. `UPDATE_RUN` has always carried its `runId`.
   */
  it('ignores a Fill that names a run the tab no longer holds', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps();

    await runFill(7, profile, deps, 'a-run-from-a-previous-posting');

    expect(deps.page.fill).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status: 'review' });
  });

  /**
   * The precondition is part of the claim, not something checked after it. Narrowing the run
   * *after* `filling` was committed left a run that failed to narrow in a busy status with no
   * controller, no failure and nothing that would ever move it off.
   */
  it('does not commit "filling" for a run whose Analysis Step data is missing', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const run = await getPipelineRun(7);
    await patchPipelineRun(7, run!.runId, { tailoredResume: null });
    const deps = makeDeps();

    await runFill(7, profile, deps);

    expect(deps.page.fill).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status: 'review' });
  });

  it('stops a Fill superseded during its scan before rendering or touching the page', async () => {
    stubChrome();
    await seedReviewRun(7, [resumeField]);
    let resolveScan!: (value: JobPageData) => void;
    const scan = new Promise<JobPageData>((resolve) => {
      resolveScan = resolve;
    });
    const staleDeps = makeDeps({ scan: vi.fn(() => scan) });
    const staleFill = runFill(7, profile, staleDeps);
    await vi.waitFor(() => expect(staleDeps.page.scan).toHaveBeenCalled());

    await runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps(), true);
    resolveScan({ fields: [resumeField] });
    await staleFill;

    expect(staleDeps.backend.renderResumePdf).not.toHaveBeenCalled();
    expect(staleDeps.page.fill).not.toHaveBeenCalled();
  });

  it('aborts a resume render a newer analysis has superseded, rather than paying for it in full', async () => {
    // The run-identity re-checks stop a superseded run from *acting* on the page; they cannot stop
    // the generation it already started. `/render-resume-pdf` is the one place a Fill Step spends
    // model time, and it used to run to completion for a run whose result nothing would use.
    stubChrome();
    await seedReviewRun(7, [resumeField]);
    let renderSignal: AbortSignal | undefined;
    const staleDeps = makeDeps({
      renderResumePdf: vi.fn((_profile: Profile, _resume: TailoredResume, signal?: AbortSignal) => {
        renderSignal = signal;
        return new Promise<ArrayBuffer>(() => {});
      }),
    });

    const staleFill = runFill(7, profile, staleDeps);
    await vi.waitFor(() => expect(staleDeps.backend.renderResumePdf).toHaveBeenCalled());
    expect(renderSignal?.aborted).toBe(false);

    await runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps(), true);

    expect(renderSignal?.aborted).toBe(true);
    // And the superseded fill neither touches the page nor checkpoints its cancellation as a
    // failure over the run that now owns the tab.
    expect(staleDeps.page.fill).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'review',
      jobDescription: 'New posting',
    });
    void staleFill;
  });

  it('drops a stale Save completion after a newer analysis claims the tab', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps();
    await runFill(7, profile, deps);
    let resolveSave!: (value: { id: string }) => void;
    const saveResult = new Promise<{ id: string }>((resolve) => {
      resolveSave = resolve;
    });
    const saving = runSaveApplication(
      7,
      makeDeps({ saveApplication: vi.fn(() => saveResult as never) }),
    );
    await vi.waitFor(async () => expect((await getPipelineRun(7))?.status).toBe('saving'));

    await runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps());
    const newerRun = await getPipelineRun(7);
    resolveSave({ id: 'stale-application' });
    await saving;

    expect(await getPipelineRun(7)).toMatchObject({
      runId: newerRun!.runId,
      status: 'review',
      jobDescription: 'New posting',
      applicationId: null,
    });
  });

  it('keeps a newer analysis authoritative when Save and Analyze race to claim the tab', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    await runFill(7, profile, makeDeps());
    const staleDeps = makeDeps();

    const staleSave = runSaveApplication(7, staleDeps);
    const newerAnalysis = runAnalysis(7, JOB_URL, profile, 'New posting', makeDeps(), true);
    await Promise.all([staleSave, newerAnalysis]);

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'review',
      jobDescription: 'New posting',
    });
  });

  it('does nothing when there is no completed Analysis Step to fill from', async () => {
    stubChrome();
    const deps = makeDeps();

    await runFill(13, profile, deps);

    expect(deps.page.fill).not.toHaveBeenCalled();
    expect(await getPipelineRun(13)).toBeNull();
  });
});

/**
 * The default adapter — what the steps above stub out. Everything the pipeline knows about HTTP and
 * `chrome.tabs` messaging lives here, so this is the only place the wire formats are asserted.
 */
describe('runFill source-status guard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  /** Leaves a run with analyzed data present and `status` forced, as a mid-flight run would look. */
  async function seedRunAt(status: PipelineStatus) {
    await seedReviewRun(7, [emailField]);
    const run = await getPipelineRun(7);
    await patchPipelineRun(7, run!.runId, { status });
  }

  // `filling` and `saving` are the two statuses the panel's Fill button is disabled for. A second
  // command arriving in one of them is either a duplicate of the step already running or an
  // out-of-sequence one; both used to pass, because the only check was that analyzed data existed.
  it.each(['filling', 'saving'] as const)('ignores a fill commanded while %s', async (status) => {
    stubChrome();
    await seedRunAt(status);
    const deps = makeDeps();

    await runFill(7, profile, deps);

    expect(deps.page.fill).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status });
  });

  // Every other status the panel can dispatch Fill from — a first fill, a retry after either
  // failure, and a deliberate re-fill after one that landed or was saved. Re-filling is supported
  // by design: the Save Step updates the same record rather than creating a second.
  it.each(['review', 'fill-error', 'filled', 'save-error', 'saved'] as const)(
    'fills when commanded from %s',
    async (status) => {
      stubChrome();
      await seedRunAt(status);
      const deps = makeDeps();

      await runFill(7, profile, deps);

      expect(deps.page.fill).toHaveBeenCalled();
      expect(await getPipelineRun(7)).toMatchObject({ status: 'filled' });
    },
  );

  it('ignores a duplicate fill dispatched while the first is still filling', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps();

    // Sequential dispatch, which is how the service worker delivers two messages: the first fill
    // has already checkpointed `filling` by the time the second arrives.
    const first = runFill(7, profile, deps);
    await first;
    const run = await getPipelineRun(7);
    await patchPipelineRun(7, run!.runId, { status: 'filling' });
    await runFill(7, profile, deps);

    expect(deps.page.fill).toHaveBeenCalledTimes(1);
  });
});

describe('the backend adapter', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives the Analysis Step off the local backend', async () => {
    stubChrome();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/extract-job')) return Promise.resolve(Response.json(jobInfo));
        if (url.endsWith('/tailor-resume')) return Promise.resolve(Response.json(tailoredResume));
        if (url.endsWith('/answer-questions')) return Promise.resolve(Response.json(answers));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    await reportDetectedPage(7, 0, {
      fields: [questionField],
    });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...');

    expect(fetch).toHaveBeenCalledWith(
      `${EXTENSION_BACKEND_ORIGIN}/extract-job`,
      expect.objectContaining({
        body: JSON.stringify({ jobDescription: 'Senior Engineer at Acme...' }),
      }),
    );
    expect(await getPipelineRun(7)).toMatchObject({ status: 'review', jobInfo, answers });
  });

  it('asks the tab to re-scan itself before filling, and fills what it answers with', async () => {
    const { tabsSendMessage } = stubChrome({
      fields: [emailField],
    });
    await seedReviewRun(7, []);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({}))),
    );

    await runFill(7, profile);

    // Four arguments, not three: both commands are addressed to the frame that reported the form.
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      { type: 'SCAN_PAGE' },
      { frameId: 0 },
      expect.any(Function),
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'FILL_FORM',
        values: { 'f-email': 'jane@example.com' },
      }),
      { frameId: 0 },
      expect.any(Function),
    );
  });

  it('sends the fill command as a FILL_FORM message, then persists only when explicitly saved', async () => {
    const { tabsSendMessage } = stubChrome();
    await seedReviewRun(7, [emailField, resumeField]);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/render-resume-pdf')
            ? new Response(pdfBytes.buffer, { status: 200 })
            : Response.json({ id: 'application-1' }),
        ),
      ),
    );

    await runFill(7, profile);

    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      {
        type: 'FILL_FORM',
        // The run being filled, so a submission the page observes afterwards can name it.
        runId: expect.any(String),
        fields: [emailField, resumeField],
        values: { 'f-email': 'jane@example.com' },
        resumeFile: {
          name: 'jane_doe_resume.pdf',
          type: 'application/pdf',
          bytes: [37, 80, 68, 70],
        },
      },
      expect.any(Function),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      `${EXTENSION_BACKEND_ORIGIN}/applications?response=compact`,
      expect.anything(),
    );

    await runSaveApplication(7);
    expect(fetch).toHaveBeenCalledWith(
      `${EXTENSION_BACKEND_ORIGIN}/applications?response=compact`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'saved',
      applicationId: 'application-1',
    });
  });
});
