import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
import type { JobPageData } from '../lib/messages';
import {
  getPipelineRun,
  patchPipelineRun,
  reportDetectedPage,
  type PipelineStatus,
} from '../lib/tabStore';
import type { BackendClient } from '../lib/backendClient';
import type { FillPageCommand, PageClient } from '../lib/pageClient';
import { runAnalysis, runFill, runSaveApplication, type PipelineDeps } from './applicationPipeline';

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
 * A fake for each collaborator. Overrides are flat — `makeDeps({ scan: … })` — since a test only
 * ever wants to replace one behaviour, and naming which of the two objects it belongs to is noise.
 */
function makeDeps(
  overrides: Partial<BackendClient> & Partial<PageClient> = {},
): PipelineDeps & { backend: BackendClient; page: PageClient } {
  const backend: BackendClient = {
    extractJob: vi.fn().mockResolvedValue(jobInfo),
    tailorResume: vi.fn().mockResolvedValue(tailoredResume),
    answerQuestions: vi.fn().mockResolvedValue(answers),
    assessRequirements: vi.fn().mockResolvedValue([]),
    renderResumePdf: vi.fn().mockResolvedValue(pdfBytes.buffer),
    // The Ask tab's route, likewise never reached from the pipeline.
    answerChat: vi.fn().mockResolvedValue({ reply: 'unused' }),
    // The Profile routes are the panel's and options page's, not the pipeline's — present because
    // the fake has to satisfy the whole interface, never called from here.
    getProfile: vi.fn().mockResolvedValue(null),
    saveProfile: vi.fn().mockResolvedValue(undefined),
    saveApplication: vi.fn().mockResolvedValue({ id: 'application-1' }),
    updateApplication: vi.fn().mockResolvedValue({ id: 'application-1' }),
    // No past application for this URL by default, so the duplicate guard lets every other test
    // through untouched.
    findApplicationDuplicates: vi.fn().mockResolvedValue({ count: 0, latest: null }),
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

  for (const [key, value] of Object.entries(overrides)) {
    if (key in backend) Object.assign(backend, { [key]: value });
    else Object.assign(page, { [key]: value });
  }

  return { backend, page };
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

    // The model is asked nothing — the profile already settles this one.
    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(prepared, jobInfo, []);
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

    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(prepared, jobInfo, [
      {
        fieldId: 'f-sponsor',
        question: 'Will you require sponsorship?',
        options: ['I have unrestricted work rights', 'I need employer support'],
        knownAnswer: 'No',
      },
    ]);
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

    expect(deps.backend.extractJob).toHaveBeenCalledWith('Senior Engineer at Acme...');
    expect(deps.backend.tailorResume).toHaveBeenCalledWith(profile, jobInfo);
    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(profile, jobInfo, [
      { fieldId: 'f-why', question: 'Why do you want to work here?' },
    ]);
    expect(await getPipelineRun(7)).toEqual({
      runId: expect.any(String),
      status: 'review',
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      jobPageData: { fields: [questionField] },
      jobDescription: 'Senior Engineer at Acme...',
      jobInfo,
      tailoredResume,
      answers,
      coverage: [],
      requirementFit: [],
      unresolvedRequiredFields: [],
      filledFieldCount: 0,
      fillOutcome: null,
      applicationId: null,
      failure: null,
      duplicateOf: null,
    });
  });

  it('checkpoints how the profile measures up to each stated requirement', async () => {
    stubChrome();
    const fit = [
      { requirement: '5 years of Go', verdict: 'unmet' as const, evidence: null, note: 'Two.' },
    ];
    const deps = makeDeps({ assessRequirements: vi.fn().mockResolvedValue(fit) });
    await reportDetectedPage(7, 0, { fields: [questionField] });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect((await getPipelineRun(7))?.requirementFit).toEqual(fit);
  });

  it('completes the analysis when the requirement assessment fails — it is advice about the run, never the run itself', async () => {
    stubChrome();
    const deps = makeDeps({
      assessRequirements: vi.fn().mockRejectedValue(new Error('backend is down')),
    });
    await reportDetectedPage(7, 0, { fields: [questionField] });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    const run = await getPipelineRun(7);
    expect(run?.status).toBe('review');
    expect(run?.requirementFit).toEqual([]);
    expect(run?.tailoredResume).toEqual(tailoredResume);
  });

  it('checkpoints what the tailored resume evidences of the posting keywords, so the panel reports the resume this run produced', async () => {
    stubChrome();
    const bullet = 'Migrated the fleet to Kubernetes';
    const deps = makeDeps();
    deps.backend.extractJob = vi
      .fn()
      .mockResolvedValue({ ...jobInfo, keywords: ['Kubernetes', 'Terraform'] });
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

    expect(deps.backend.answerQuestions).toHaveBeenCalledWith(profile, jobInfo, [
      {
        fieldId: 'f-auth',
        question: 'Are you authorized to work in the US?',
        options: ['Yes', 'No'],
      },
    ]);
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

  it("checkpoints the underlying cause alongside 'analyze-error', so the panel can report which call failed instead of a generic message", async () => {
    stubChrome();
    await reportDetectedPage(7, 0, { fields: [] });
    const deps = makeDeps({
      answerQuestions: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'POST /answer-questions failed (500): report_answers did not produce a tool call.',
          ),
        ),
    });

    await runAnalysis(7, null, profile, 'Senior Engineer at Acme...', deps);

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'analyze-error',
      failure: {
        step: 'analysis',
        message: 'POST /answer-questions failed (500): report_answers did not produce a tool call.',
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
      failure: { step: 'analysis', message: 'session read failed' },
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
          createdAt: LATER,
        },
      }),
    });

    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', deps);

    expect(deps.backend.findApplicationDuplicates).toHaveBeenCalledWith(JOB_URL);
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
        latest: { id: 'application-1', company: 'Acme', roleTitle: 'X', createdAt: LATER },
      }),
    });

    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', deps, true);

    // Not even asked: forcing means the answer cannot change anything.
    expect(deps.backend.findApplicationDuplicates).not.toHaveBeenCalled();
    expect(await getPipelineRun(7)).toMatchObject({ status: 'review', duplicateOf: null });
  });

  it('analyzes anyway when the duplicate check itself fails', async () => {
    // The guard is advisory — a backend that isn't running must not be why Analyze stops working.
    stubChrome();
    const deps = makeDeps({
      findApplicationDuplicates: vi.fn().mockRejectedValue(new Error('backend unreachable')),
    });

    await runAnalysis(7, JOB_URL, profile, 'Senior Engineer at Acme...', deps);

    expect(await getPipelineRun(7)).toMatchObject({ status: 'review', duplicateOf: null });
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
    expect(deps.backend.renderResumePdf).toHaveBeenCalledWith(profile, tailoredResume);
    expect(deps.page.fill).toHaveBeenCalledWith(
      7,
      {
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
      failure: { step: 'save', message: 'backend unreachable' },
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
      'http://127.0.0.1:5391/extract-job',
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
      'http://127.0.0.1:5391/applications?response=compact',
      expect.anything(),
    );

    await runSaveApplication(7);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5391/applications?response=compact',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await getPipelineRun(7)).toMatchObject({
      status: 'saved',
      applicationId: 'application-1',
    });
  });
});
