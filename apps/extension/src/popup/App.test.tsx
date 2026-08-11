import type { DetectedField, JobInfo, Profile, QuestionAnswer, TailoredResume } from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { AnalysisFailedError, FillFailedError } from './pipeline';

const { analyzeJobPage, fillAndSubmit } = vi.hoisted(() => ({
  analyzeJobPage: vi.fn(),
  fillAndSubmit: vi.fn(),
}));

vi.mock('./pipeline', async () => {
  const actual = await vi.importActual<typeof import('./pipeline')>('./pipeline');
  return { ...actual, analyzeJobPage, fillAndSubmit };
});

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

interface StubOptions {
  tabUrl: string;
  tabId?: number;
  profile: Profile | null;
  jobPageData?: { pageText: string; fields: DetectedField[] } | null;
}

/**
 * Stubs `chrome.tabs.query` (active tab) and `chrome.runtime.sendMessage` for the two things
 * `App.tsx` still talks to directly: `GET /profile` and `GET_JOB_PAGE_DATA`. The application
 * pipeline itself (`analyzeJobPage`/`fillAndSubmit`) is mocked at the module level above, so
 * these tests only assert on status -> render wiring, not on how analysis/filling happens.
 */
function stubChrome(options: StubOptions) {
  const openOptionsPage = vi.fn();
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
      callback({ data: undefined });
    },
  );
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn((_query: unknown, callback: (tabs: { id: number; url: string }[]) => void) =>
        callback([{ id: options.tabId ?? 1, url: options.tabUrl }]),
      ),
    },
    runtime: { sendMessage, openOptionsPage },
  });
  return { openOptionsPage, sendMessage };
}

describe('popup App', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    analyzeJobPage.mockReset();
    fillAndSubmit.mockReset();
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

  it('prompts to navigate to a supported page when the profile exists but the tab is unsupported', async () => {
    stubChrome({ tabUrl: 'https://example.com', profile });

    render(<App />);

    await screen.findByText('Navigate to a supported job application page to get started.');
  });

  it('shows a not-detected state with a retry button when no job page has been found', async () => {
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData: null,
    });

    render(<App />);

    await screen.findByText("Couldn't find an application form on this page yet.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('retries detection and proceeds once "Try again" finds a job page', async () => {
    analyzeJobPage.mockResolvedValue({ jobInfo, tailoredResume, answers });

    let jobPageDataCalls = 0;
    const sendMessage = vi.fn(
      (message: Record<string, unknown>, callback: (response: unknown) => void) => {
        if (message.type === 'GET_JOB_PAGE_DATA') {
          jobPageDataCalls += 1;
          callback({ data: jobPageDataCalls === 1 ? null : jobPageData });
          return;
        }
        if (message.path === '/profile') {
          callback({ data: profile });
          return;
        }
        callback({ data: undefined });
      },
    );
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn((_query: unknown, callback: (tabs: { id: number; url: string }[]) => void) =>
          callback([{ id: 1, url: 'https://boards.greenhouse.io/acme/jobs/1' }]),
        ),
      },
      runtime: { sendMessage, openOptionsPage: vi.fn() },
    });

    render(<App />);

    await screen.findByText("Couldn't find an application form on this page yet.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Senior Engineer at Acme');
    expect(jobPageDataCalls).toBe(2);
  });

  it('shows an editable review once analysis succeeds', async () => {
    analyzeJobPage.mockResolvedValue({ jobInfo, tailoredResume, answers });
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);

    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill form' })).toBeInTheDocument();
    expect(analyzeJobPage).toHaveBeenCalledWith(jobPageData, profile, expect.anything());
  });

  it('shows an error and retries analysis when the user clicks "Try again"', async () => {
    analyzeJobPage
      .mockRejectedValueOnce(new AnalysisFailedError(new Error('backend unreachable')))
      .mockResolvedValueOnce({ jobInfo, tailoredResume, answers });
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);

    await screen.findByText('Something went wrong analyzing this job posting.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Senior Engineer at Acme');
    expect(analyzeJobPage).toHaveBeenCalledTimes(2);
  });

  it('fills the form and saves the application when "Fill form" is clicked', async () => {
    analyzeJobPage.mockResolvedValue({ jobInfo, tailoredResume, answers });
    fillAndSubmit.mockResolvedValue(undefined);
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<App />);
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText('Filled and application saved.');
    expect(fillAndSubmit).toHaveBeenCalledWith(
      jobPageData,
      profile,
      jobInfo,
      tailoredResume,
      answers,
      1,
      'https://boards.greenhouse.io/acme/jobs/1',
      expect.anything(),
    );
  });

  it('ignores extra clicks on "Fill form" while a fill is already in flight', async () => {
    analyzeJobPage.mockResolvedValue({ jobInfo, tailoredResume, answers });
    let resolveFill: () => void;
    fillAndSubmit.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveFill = resolve;
      }),
    );
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    const fillButton = await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(fillButton);
    fireEvent.click(fillButton);

    expect(fillAndSubmit).toHaveBeenCalledTimes(1);

    resolveFill!();
    await screen.findByText('Filled and application saved.');
  });

  it('shows an error and retries filling when the user clicks "Try again"', async () => {
    analyzeJobPage.mockResolvedValue({ jobInfo, tailoredResume, answers });
    fillAndSubmit
      .mockRejectedValueOnce(new FillFailedError(new Error('backend unreachable')))
      .mockResolvedValueOnce(undefined);
    stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App />);
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText('Something went wrong filling the form and saving the application.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Filled and application saved.');
    expect(fillAndSubmit).toHaveBeenCalledTimes(2);
  });
});
