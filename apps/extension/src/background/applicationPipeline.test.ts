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
import { getPipelineRun, reportDetectedPage } from '../lib/tabStore';
import type { BackendClient } from '../lib/backendClient';
import type { PageClient } from '../lib/pageClient';
import { runAnalysis, runFill, type PipelineDeps } from './applicationPipeline';

/**
 * The Analysis and Fill Steps used to be tested separately from the checkpointing that drives them,
 * in `panel/pipeline.test.ts` and `background/pipelineRunner.test.ts` — which asserted the same
 * outcomes twice, once as a returned value and once as a stored run. They're one module now, so
 * every test here goes through `runAnalysis`/`runFill` and reads the result out of the store.
 *
 * Dependencies are passed in rather than `vi.mock`ed: the seam is a parameter, so a test needn't
 * reach around the module to replace what it calls. The two tests at the bottom deliberately don't
 * pass any, exercising the real adapter — that's where the wire encoding lives.
 */

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
  const tabsSendMessage = vi.fn(
    (_tabId: number, message: { type: string }, callback: (r: unknown) => void) =>
      callback(message.type === 'SCAN_PAGE' ? scanReply : { ok: true }),
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
    renderResumePdf: vi.fn().mockResolvedValue(pdfBytes.buffer),
    saveApplication: vi.fn().mockResolvedValue(undefined),
  };
  const page: PageClient = {
    // `null` — no account from the page, so the step falls back to the values it drafted. Tests
    // that care about the page's own report override this.
    fill: vi.fn().mockResolvedValue(null),
    // No re-scan by default, so each test states for itself whether the live page answers — the
    // `null` path (no content script in the tab) falls back to the run's own detection.
    scan: vi.fn().mockResolvedValue(null),
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
      status: 'review',
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      jobPageData: { fields: [questionField] },
      jobDescription: 'Senior Engineer at Acme...',
      jobInfo,
      tailoredResume,
      answers,
      unresolvedRequiredFields: [],
      filledFieldCount: 0,
      failure: null,
    });
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

  it('does nothing when no job description was pasted — there is nothing to analyze', async () => {
    stubChrome();
    const deps = makeDeps();

    await runAnalysis(11, null, profile, '   ', deps);

    expect(deps.backend.extractJob).not.toHaveBeenCalled();
    expect(await getPipelineRun(11)).toBeNull();
  });
});

describe('runFill', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills scalar and question fields, saves the application, and checkpoints "filled"', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField, questionField]);
    const deps = makeDeps();

    await runFill(7, profile, deps);

    expect(deps.backend.renderResumePdf).not.toHaveBeenCalled();
    expect(deps.page.fill).toHaveBeenCalledWith(7, {
      fields: [emailField, questionField],
      values: { 'f-email': 'jane@example.com', 'f-why': 'Draft answer.' },
      resume: undefined,
    });
    expect(deps.backend.saveApplication).toHaveBeenCalledWith({
      company: 'Acme',
      roleTitle: 'Senior Engineer',
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      jobInfo,
      tailoredResume,
      answers,
      status: 'draft',
    });
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

    expect(deps.page.fill).toHaveBeenCalledWith(7, {
      fields: [emailField],
      values: { 'f-email': 'jane@example.com' },
      resume: undefined,
    });
    expect(await getPipelineRun(7)).toMatchObject({ filledFieldCount: 1 });
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
    );
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

    await runFill(7, profile, makeDeps());

    expect(await getPipelineRun(7)).toMatchObject({
      filledFieldCount: 0,
      unresolvedRequiredFields: [],
    });
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
    expect(deps.page.fill).toHaveBeenCalledWith(7, {
      fields: [decoyField, resumeField],
      values: {},
      resume: { name: 'jane_doe_resume.pdf', type: 'application/pdf', bytes: pdfBytes.buffer },
    });
    expect(await getPipelineRun(7)).toMatchObject({ unresolvedRequiredFields: [] });
  });

  it('checkpoints "fill-error" with the cause when saving the application fails', async () => {
    stubChrome();
    await seedReviewRun(7, [emailField]);
    const deps = makeDeps({
      saveApplication: vi.fn().mockRejectedValue(new Error('backend unreachable')),
    });

    await runFill(7, profile, deps);

    expect(await getPipelineRun(7)).toMatchObject({
      status: 'fill-error',
      failure: { step: 'fill', message: 'backend unreachable' },
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

    expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: 'SCAN_PAGE' }, expect.any(Function));
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'FILL_FORM',
        values: { 'f-email': 'jane@example.com' },
      }),
      expect.any(Function),
    );
  });

  it('sends the fill command to the tab as a FILL_FORM message, encoding the resume as a plain number[] the runtime can carry', async () => {
    const { tabsSendMessage } = stubChrome();
    await seedReviewRun(7, [emailField, resumeField]);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/render-resume-pdf')
            ? new Response(pdfBytes.buffer, { status: 200 })
            : Response.json({}),
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
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5391/applications',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await getPipelineRun(7)).toMatchObject({ status: 'filled' });
  });
});
