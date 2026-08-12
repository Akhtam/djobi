import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPipelineRun, reportDetectedPage } from '../lib/tabStore';
import { runAnalysis, runFill } from './pipelineRunner';

const { mockCallBackend, mockFetchResumePdf } = vi.hoisted(() => ({
  mockCallBackend: vi.fn(),
  mockFetchResumePdf: vi.fn(),
}));

vi.mock('./callBackend', () => ({ callBackend: mockCallBackend }));
vi.mock('../lib/fetchResumePdf', () => ({ fetchResumePdf: mockFetchResumePdf }));

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

/** Same in-memory `chrome.storage.session` stand-in as `tabStore.test.ts`. */
function stubChrome() {
  const data = new Map<string, unknown>();
  const tabsSendMessage = vi.fn(
    (_tabId: number, _message: unknown, callback: (r: unknown) => void) => callback({ ok: true }),
  );

  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn((key: string) => Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {})),
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
    tabs: { sendMessage: tabsSendMessage },
  });

  return { tabsSendMessage };
}

describe('pipelineRunner', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockCallBackend.mockReset();
    mockFetchResumePdf.mockReset();
  });

  describe('runAnalysis', () => {
    it('checkpoints an "analyzing" run, then the completed Analysis Step results, into tabStore', async () => {
      stubChrome();
      await reportDetectedPage(7, 0, {
        pageText: 'Senior Engineer at Acme...',
        fields: [questionField],
      });
      mockCallBackend.mockImplementation((path: string) => {
        if (path === '/extract-job') return Promise.resolve(jobInfo);
        if (path === '/tailor-resume') return Promise.resolve(tailoredResume);
        if (path === '/answer-questions') return Promise.resolve(answers);
        throw new Error(`unexpected callBackend path: ${path}`);
      });

      await runAnalysis(7, 'https://boards.greenhouse.io/acme/jobs/1', profile, null);

      expect(await getPipelineRun(7)).toEqual({
        status: 'review',
        tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        jobPageData: { pageText: 'Senior Engineer at Acme...', fields: [questionField] },
        pageTextOverride: null,
        jobInfo,
        tailoredResume,
        answers,
        unresolvedRequiredFields: [],
        filledFieldCount: 0,
        failure: null,
      });
    });

    it('checkpoints "analyze-error" when the backend call fails, instead of throwing to a caller that may no longer be listening', async () => {
      stubChrome();
      await reportDetectedPage(7, 0, { pageText: 'Senior Engineer at Acme...', fields: [] });
      mockCallBackend.mockRejectedValue(new Error('backend unreachable'));

      await runAnalysis(7, null, profile, null);

      expect(await getPipelineRun(7)).toMatchObject({ status: 'analyze-error' });
    });

    it("checkpoints the underlying cause alongside 'analyze-error', so the panel can report which call failed instead of a generic message", async () => {
      stubChrome();
      await reportDetectedPage(7, 0, { pageText: 'Senior Engineer at Acme...', fields: [] });
      mockCallBackend.mockRejectedValue(
        new Error(
          'POST /answer-questions failed (500): report_answers did not produce a tool call.',
        ),
      );

      await runAnalysis(7, null, profile, null);

      expect(await getPipelineRun(7)).toMatchObject({
        status: 'analyze-error',
        failure: {
          step: 'analysis',
          message:
            'POST /answer-questions failed (500): report_answers did not produce a tool call.',
        },
      });
    });

    it('clears a previous failure when a fresh analysis starts, so a stale reason never outlives the run that produced it', async () => {
      stubChrome();
      await reportDetectedPage(7, 0, { pageText: 'Senior Engineer at Acme...', fields: [] });
      mockCallBackend.mockRejectedValue(new Error('backend unreachable'));
      await runAnalysis(7, null, profile, null);
      expect(await getPipelineRun(7)).toMatchObject({ failure: { step: 'analysis' } });

      mockCallBackend.mockReset();
      mockCallBackend.mockImplementation((path: string) => {
        if (path === '/extract-job') return Promise.resolve(jobInfo);
        if (path === '/tailor-resume') return Promise.resolve(tailoredResume);
        if (path === '/answer-questions') return Promise.resolve(answers);
        throw new Error(`unexpected callBackend path: ${path}`);
      });
      await runAnalysis(7, null, profile, null);

      expect(await getPipelineRun(7)).toMatchObject({ status: 'review', failure: null });
    });

    it('analyzes pasted text with no fields when no job page was ever detected for the tab', async () => {
      stubChrome();
      mockCallBackend.mockImplementation((path: string) => {
        if (path === '/extract-job') return Promise.resolve(jobInfo);
        if (path === '/tailor-resume') return Promise.resolve(tailoredResume);
        if (path === '/answer-questions') return Promise.resolve([]);
        throw new Error(`unexpected callBackend path: ${path}`);
      });

      await runAnalysis(9, null, profile, 'Pasted job description text.');

      expect(await getPipelineRun(9)).toMatchObject({
        jobPageData: { pageText: 'Pasted job description text.', fields: [] },
      });
    });

    it('does nothing when there is no detected job page and no pasted text to analyze', async () => {
      stubChrome();

      await runAnalysis(11, null, profile, null);

      expect(mockCallBackend).not.toHaveBeenCalled();
      expect(await getPipelineRun(11)).toBeNull();
    });
  });

  describe('runFill', () => {
    async function seedReviewRun(tabId: number) {
      await reportDetectedPage(tabId, 0, {
        pageText: 'Senior Engineer at Acme...',
        fields: [questionField],
      });
      mockCallBackend.mockImplementation((path: string) => {
        if (path === '/extract-job') return Promise.resolve(jobInfo);
        if (path === '/tailor-resume') return Promise.resolve(tailoredResume);
        if (path === '/answer-questions') return Promise.resolve(answers);
        throw new Error(`unexpected callBackend path: ${path}`);
      });
      await runAnalysis(tabId, 'https://boards.greenhouse.io/acme/jobs/1', profile, null);
      mockCallBackend.mockReset();
    }

    it('fills the form and saves the application, checkpointing "filled" once done', async () => {
      const { tabsSendMessage } = stubChrome();
      await seedReviewRun(7);
      mockCallBackend.mockResolvedValue(undefined); // saveApplication -> POST /applications

      await runFill(7, profile);

      expect(tabsSendMessage).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: 'FILL_FORM' }),
        expect.any(Function),
      );
      expect(mockCallBackend).toHaveBeenCalledWith(
        '/applications',
        expect.objectContaining({ company: 'Acme' }),
      );
      expect(await getPipelineRun(7)).toMatchObject({ status: 'filled' });
    });

    it('checkpoints unresolvedRequiredFields from fillAndSubmit, so a required field with no resolvable value doesn\'t silently disappear behind a "filled" status', async () => {
      const requiredMysteryField: DetectedField = {
        id: 'f-mystery',
        label: 'Referral code',
        inputType: 'text',
        selector: '#mystery-field',
        category: 'unknown',
        required: true,
        elementRole: 'native',
      };
      stubChrome();
      await reportDetectedPage(7, 0, {
        pageText: 'Senior Engineer at Acme...',
        fields: [questionField, requiredMysteryField],
      });
      mockCallBackend.mockImplementation((path: string) => {
        if (path === '/extract-job') return Promise.resolve(jobInfo);
        if (path === '/tailor-resume') return Promise.resolve(tailoredResume);
        if (path === '/answer-questions') return Promise.resolve(answers);
        throw new Error(`unexpected callBackend path: ${path}`);
      });
      await runAnalysis(7, 'https://boards.greenhouse.io/acme/jobs/1', profile, null);
      mockCallBackend.mockReset();
      mockCallBackend.mockResolvedValue(undefined); // saveApplication -> POST /applications

      await runFill(7, profile);

      expect(await getPipelineRun(7)).toMatchObject({
        status: 'filled',
        unresolvedRequiredFields: [requiredMysteryField],
      });
    });

    it('checkpoints "fill-error" when saving the application fails', async () => {
      stubChrome();
      await seedReviewRun(7);
      mockCallBackend.mockRejectedValue(new Error('backend unreachable'));

      await runFill(7, profile);

      expect(await getPipelineRun(7)).toMatchObject({
        status: 'fill-error',
        failure: { step: 'fill', message: 'backend unreachable' },
      });
    });

    it('does nothing when there is no completed Analysis Step to fill from', async () => {
      const { tabsSendMessage } = stubChrome();

      await runFill(13, profile);

      expect(tabsSendMessage).not.toHaveBeenCalled();
      expect(await getPipelineRun(13)).toBeNull();
    });
  });
});
