import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

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

interface StubOptions {
  tabUrl: string;
  tabId?: number;
  profile: Profile | null;
  jobPageData?: { pageText: string; fields: DetectedField[] } | null;
  responses?: Record<string, unknown>;
}

/**
 * Stubs `chrome.tabs.query` (active tab) and `chrome.runtime.sendMessage`, routing responses by
 * message shape: `{ type: 'GET_JOB_PAGE_DATA' }` -> `jobPageData`, `{ path: '/profile' }` ->
 * `profile`, any other `{ path }` -> `responses[path]`, `{ type: 'FILL_FORM' }` ->
 * `responses.FILL_FORM`.
 */
function stubChrome(options: StubOptions) {
  const openOptionsPage = vi.fn();
  const sendMessage = vi.fn(
    (message: Record<string, unknown>, callback: (response: unknown) => void) => {
      if (message.type === 'GET_JOB_PAGE_DATA') {
        callback({ data: options.jobPageData ?? null });
        return;
      }
      if (message.type === 'FILL_FORM') {
        callback(options.responses?.FILL_FORM ?? { ok: true });
        return;
      }
      if (message.path === '/profile') {
        callback({ data: options.profile });
        return;
      }
      callback({ data: options.responses?.[message.path as string] });
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

  it('shows a ready state when the profile exists, the tab is supported, but no job page has been detected yet', async () => {
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData: null,
    });

    render(<App />);

    await screen.findByText('djobi is ready on this page.');
  });

  it('analyzes a detected job page and shows an editable review with drafted answers', async () => {
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData: { pageText: 'Senior Engineer at Acme...', fields: [questionField] },
      responses: {
        '/extract-job': jobInfo,
        '/tailor-resume': tailoredResume,
        '/answer-questions': answers,
      },
    });

    render(<App />);

    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill form' })).toBeInTheDocument();
  });

  it('fills the form and saves the application when "Fill form" is clicked', async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(pdfBytes.buffer, { status: 200 })),
    );
    const resumeField: DetectedField = {
      id: 'f-resume',
      label: 'Resume',
      inputType: 'file',
      selector: '#resume-field',
      category: 'resume_upload',
    };
    const { sendMessage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData: { pageText: 'Senior Engineer at Acme...', fields: [questionField, resumeField] },
      responses: {
        '/extract-job': jobInfo,
        '/tailor-resume': tailoredResume,
        '/answer-questions': answers,
      },
    });

    render(<App />);
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText('Filled and application saved.');

    const fillCall = sendMessage.mock.calls.find(
      ([message]) => (message as { type?: string }).type === 'FILL_FORM',
    )?.[0] as {
      tabId: number;
      values: Record<string, string>;
      resumeFile: { name: string; type: string; bytes: number[] };
    };
    expect(fillCall.tabId).toBe(1);
    expect(fillCall.values).toMatchObject({ 'f-why': 'Draft answer.' });
    expect(fillCall.resumeFile).toMatchObject({ name: 'resume.pdf', type: 'application/pdf' });

    const saveCall = sendMessage.mock.calls.find(
      ([message]) => (message as { path?: string }).path === '/applications',
    )?.[0] as { body: { company: string; roleTitle: string } };
    expect(saveCall.body).toMatchObject({ company: 'Acme', roleTitle: 'Senior Engineer' });
  });
});
