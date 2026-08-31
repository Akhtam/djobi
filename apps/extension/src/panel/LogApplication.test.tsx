/**
 * The Log tab, driven through the same `BackendClient` seam the rest of the panel's tests use.
 *
 * Nothing here goes near `applicationPipeline` or `tabStore` on purpose — that this flow needs
 * neither is the whole reason it's a separate tab, so a test that had to stub them would be
 * evidence the split had leaked.
 */
import { baseResumeOf, type Application, type JobInfo, type Profile } from '@djobi/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBackendClient, type BackendClient } from '../lib/backendClient';
import { LogApplication } from './LogApplication';

/** The client this tab is handed, rebuilt per case by {@link stubBackend}. */
let client: BackendClient;

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [
    {
      company: 'Northwind',
      title: 'Software Engineer',
      startDate: '2021-06',
      endDate: null,
      bullets: ['Built the billing portal.'],
      maxBullets: null,
      starredIndices: [],
    },
  ],
  maxBulletsPerRole: 6,
  education: [],
  skills: ['TypeScript', 'Postgres'],
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
  requirements: ['5+ years'],
  keywords: ['TypeScript'],
};

const JOB_URL = 'https://acme.com/jobs/123';
const JOB_DESCRIPTION = 'Senior Engineer at Acme, building the platform team.';

interface StubOptions {
  /** Applications already stored against this job URL — what the duplicate warning reads. */
  existing?: Application[];
  /** The duplicate lookup itself failing — a warning the backend couldn't answer. */
  duplicateFailure?: string;
  extractFailure?: string;
  saveFailure?: string;
  saveResult?: Promise<unknown>;
}

/** Answers the three operations this tab performs, and hands back what it asked to save. */
function stubBackend(options: StubOptions = {}) {
  const saved: unknown[] = [];

  client = createFakeBackendClient({
    extractJob: vi.fn(async () => {
      if (options.extractFailure) throw new Error(options.extractFailure);
      return jobInfo;
    }),
    findApplicationDuplicates: async () => {
      if (options.duplicateFailure) throw new Error(options.duplicateFailure);
      const existing = options.existing ?? [];
      const latest = existing[0];
      return {
        count: existing.length,
        latest: latest
          ? {
              id: latest.id,
              company: latest.company,
              roleTitle: latest.roleTitle,
              stage: latest.stage,
              createdAt: latest.createdAt,
            }
          : null,
      };
    },
    saveApplication: async (payload) => {
      if (options.saveFailure) throw new Error(options.saveFailure);
      saved.push(payload);
      if (options.saveResult) return options.saveResult as never;
      return { id: 'application-1' };
    },
  } as Partial<BackendClient>);

  return { saved };
}

function renderTab(activeTabUrl: string | null = JOB_URL) {
  return render(<LogApplication client={client} profile={profile} activeTabUrl={activeTabUrl} />);
}

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

/** Paste, extract, and land on the review step. */
async function extract() {
  type(screen.getByPlaceholderText(/Paste the posting/), JOB_DESCRIPTION);
  fireEvent.click(screen.getByRole('button', { name: 'Extract job details' }));
  await screen.findByRole('heading', { name: 'Check the details' });
}

beforeEach(() => {
  stubBackend();
});

describe('the Log tab', () => {
  it('prefills the URL from the tab the candidate is on', () => {
    stubBackend();
    renderTab();

    expect(screen.getByPlaceholderText('https://…')).toHaveValue(JOB_URL);
    expect(screen.getByRole('textbox', { name: 'Manual job description' })).toBeInTheDocument();
  });

  it('files the application with the base profile and a manual source', async () => {
    const { saved } = stubBackend();
    renderTab();

    await extract();
    fireEvent.click(screen.getByRole('button', { name: 'Log application' }));

    await screen.findByText('Logged Senior Engineer at Acme.');
    expect(saved).toEqual([
      {
        company: 'Acme',
        roleTitle: 'Senior Engineer',
        jobUrl: JOB_URL,
        jobInfo,
        // The authored resume content straight through, without Profile-only selection controls.
        tailoredResume: baseResumeOf(profile),
        answers: [],
        source: 'manual',
      },
    ]);
  });

  /**
   * `jobUrl` is `.url()`-validated by `NewApplicationSchema` and is the duplicate guard's key, so a
   * bad one has to stop in the panel rather than come back as a 400.
   */
  /**
   * The panel outlives a navigation. Seeding the field only on mount filed the row under whichever
   * posting was open when the panel was, which is also the URL the duplicate guard then checked.
   */
  it('follows the tab while the URL is still the prefill', async () => {
    stubBackend();
    const { rerender } = renderTab();

    rerender(
      <LogApplication client={client} profile={profile} activeTabUrl="https://acme.com/jobs/456" />,
    );

    expect(screen.getByPlaceholderText('https://…')).toHaveValue('https://acme.com/jobs/456');
  });

  it('stops following the tab once the candidate types a URL', async () => {
    stubBackend();
    const { rerender } = renderTab();

    type(screen.getByPlaceholderText('https://…'), 'https://acme.com/jobs/mine');
    rerender(
      <LogApplication client={client} profile={profile} activeTabUrl="https://acme.com/jobs/456" />,
    );

    expect(screen.getByPlaceholderText('https://…')).toHaveValue('https://acme.com/jobs/mine');
  });

  /** Past the extraction the URL describes what's on screen, not what the browser is showing. */
  it('stops following the tab once there is an extraction to review', async () => {
    stubBackend();
    const { rerender } = renderTab();

    await extract();
    rerender(
      <LogApplication client={client} profile={profile} activeTabUrl="https://acme.com/jobs/456" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Log application' }));
    await screen.findByText('Logged Senior Engineer at Acme.');
    // Still the URL the description was extracted from.
    expect(screen.queryByText(/jobs\/456/)).not.toBeInTheDocument();
  });

  it('will not extract without a usable URL', async () => {
    stubBackend();
    renderTab(null);

    type(screen.getByPlaceholderText('https://…'), 'acme.com/jobs/123');
    type(screen.getByPlaceholderText(/Paste the posting/), JOB_DESCRIPTION);

    expect(screen.getByRole('button', { name: 'Extract job details' })).toBeDisabled();
    expect(screen.getByText(/doesn't look like a URL/)).toBeInTheDocument();
    expect(client.extractJob).not.toHaveBeenCalled();
  });

  it('will not extract without a job description', async () => {
    stubBackend();
    renderTab();

    expect(screen.getByRole('button', { name: 'Extract job details' })).toBeDisabled();
  });

  it('carries an edited company and role into the stored snapshot too', async () => {
    const { saved } = stubBackend();
    renderTab();

    await extract();
    type(screen.getByRole('textbox', { name: 'Company' }), 'Acme Corp');
    fireEvent.click(screen.getByRole('button', { name: 'Log application' }));

    await screen.findByText('Logged Senior Engineer at Acme Corp.');
    // Not just the column: the `jobInfo` snapshot carries the correction, so a half-applied edit
    // can't leave the two disagreeing.
    expect(saved).toEqual([
      expect.objectContaining({
        company: 'Acme Corp',
        jobInfo: expect.objectContaining({ company: 'Acme Corp' }),
      }),
    ]);
  });

  it('disables reviewed fields while logging the snapshot', async () => {
    const pending = new Promise(() => undefined);
    stubBackend({ saveResult: pending });
    renderTab();
    await extract();

    fireEvent.click(screen.getByRole('button', { name: 'Log application' }));

    expect(screen.getByRole('textbox', { name: 'Company' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Role' })).toBeDisabled();
  });

  it('logs the application anyway when the duplicate lookup itself fails', async () => {
    // The Duplicate Guard warns; it never gates. This flow used to run the lookup beside the
    // extraction in one `Promise.all` and call the pair, so a backend that couldn't answer a
    // *warning* reported the extraction as failed — throwing away a model call that had already
    // succeeded and leaving the candidate unable to record an application they had made. The rule
    // now lives in `lib/duplicateGuard.ts`, which resolves rather than rejects.
    const { saved } = stubBackend({ duplicateFailure: 'Failed to fetch' });
    // The guard's own warning; asserted where failing open is the subject, in
    // `background/applicationPipeline.test.ts`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderTab();

    await extract();

    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    expect(screen.queryByText(/already logged this job/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log application' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Log application' }));
    await screen.findByText(/Logged Senior Engineer at Acme/);
    expect(saved).toHaveLength(1);
    warn.mockRestore();
  });

  it('warns about a job already logged, without blocking it', async () => {
    const { saved } = stubBackend({
      existing: [
        {
          id: 'application-0',
          company: 'Acme',
          roleTitle: 'Senior Engineer',
          jobUrl: JOB_URL,
          jobInfo,
          tailoredResume: { skills: [], workExperience: [] },
          answers: [],
          source: 'manual',
          stage: 'applied',
          notes: [],
          createdAt: '2026-08-07T00:00:00.000Z',
        },
      ],
    });
    renderTab();

    await extract();
    expect(screen.getByText(/You already logged this job on/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Log it anyway' }));
    await screen.findByText('Logged Senior Engineer at Acme.');
    expect(saved).toHaveLength(1);
  });

  it('reports a failed extraction and lets it be retried', async () => {
    stubBackend({ extractFailure: 'POST /extract-job failed: 500' });
    renderTab();

    type(screen.getByPlaceholderText(/Paste the posting/), JOB_DESCRIPTION);
    fireEvent.click(screen.getByRole('button', { name: 'Extract job details' }));

    expect(await screen.findByText('POST /extract-job failed: 500')).toBeInTheDocument();
    // Back on the form with the paste intact, not a dead end.
    expect(screen.getByPlaceholderText(/Paste the posting/)).toHaveValue(JOB_DESCRIPTION);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  /** A failed save must keep the reviewed details on screen — they're not recoverable otherwise. */
  it('reports a failed save without losing the extraction', async () => {
    stubBackend({ saveFailure: 'POST /applications failed: 500' });
    renderTab();

    await extract();
    fireEvent.click(screen.getByRole('button', { name: 'Log application' }));

    expect(await screen.findByText('POST /applications failed: 500')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Company' })).toHaveValue('Acme');
    expect(screen.getByRole('button', { name: 'Log application' })).toBeEnabled();
  });

  it('resets to an empty form after logging one', async () => {
    stubBackend();
    renderTab();

    await extract();
    fireEvent.click(screen.getByRole('button', { name: 'Log application' }));
    await screen.findByText('Logged Senior Engineer at Acme.');

    fireEvent.click(screen.getByRole('button', { name: 'Log another' }));

    await waitFor(() => expect(screen.getByPlaceholderText(/Paste the posting/)).toHaveValue(''));
    // The URL goes back to the tracked tab's, not to empty — the next posting is usually the one
    // the candidate has just navigated to.
    expect(screen.getByPlaceholderText('https://…')).toHaveValue(JOB_URL);
  });
});
