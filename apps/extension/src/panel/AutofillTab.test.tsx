/**
 * The Autofill Tab — the Application Pipeline as the candidate drives it.
 *
 * These cases moved here wholesale when the flow moved out of `panel/App.tsx`; they were always
 * about this flow rather than about the shell that used to host it.
 *
 * `AutofillHarness` supplies the two things the shell supplies in production — a Profile and an
 * `ActiveRun` — and nothing else. It calls the real `useActiveRun`, so each case still covers the
 * whole round trip the tab depends on: message -> `background/applicationPipeline.ts` ->
 * `lib/tabStore/pipelineRun.ts` -> `chrome.storage.onChanged` -> hook -> render.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutofillTab } from './AutofillTab';
import { useActiveRun } from './useActiveRun';
import {
  JOB_DESCRIPTION,
  answers,
  callsOfType,
  clickAnalyze,
  deferred,
  jobPageData,
  panelClient,
  profile,
  questionField,
  resetPanelTestEnv,
  stubChrome,
  tailoredResume,
} from './panelTestHarness';
import type { DetectedField } from '@djobi/shared';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
import type { PostingReadOutcome } from '../lib/pageClient';
import { reportDetectedPage } from '../lib/tabStore/detectedPage';
import { getJobContext, setJobContext } from '../lib/tabStore/jobContext';
import { clearTabState } from '../lib/tabStore/lifecycle';
import { getPipelineRun, patchPipelineRun } from '../lib/tabStore/pipelineRun';
import { HttpError } from '../lib/callBackend';

/** The tab as the shell mounts it: a Profile, the real run handle, and nothing else. */
function AutofillHarness({
  onRefineAnswer = () => {},
  readPosting,
}: {
  onRefineAnswer?: (fieldId: string, question: string, currentAnswer: string) => void;
  readPosting?: (tabId: number) => Promise<PostingReadOutcome>;
}) {
  const activeRun = useActiveRun(true);
  return (
    <AutofillTab
      client={panelClient()}
      profile={profile}
      activeRun={activeRun}
      onRefineAnswer={onRefineAnswer}
      readPosting={readPosting}
      hidden={false}
    />
  );
}

describe('AutofillTab', () => {
  beforeEach(resetPanelTestEnv);

  it('shows a paste box and an "Analyze" button immediately on open, even before/without any job page being detected', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://example.com',
      profile,
      jobPageData: null,
    });

    render(<AutofillHarness />);

    await screen.findByRole('button', { name: 'Analyze' });
    expect(screen.getByPlaceholderText(/paste the job description/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Job description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Extract job posting' })).toBeInTheDocument();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
  });

  it('scrapes into the editable textarea without starting Analysis automatically', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://jobs.ashbyhq.com/acme/job-id',
      profile,
      jobPageData: null,
    });
    const readPosting = vi.fn(() =>
      Promise.resolve({
        status: 'success' as const,
        candidate: { text: JOB_DESCRIPTION, score: 120, source: 'structured-data' as const },
      }),
    );
    render(<AutofillHarness readPosting={readPosting} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Extract job posting' }));

    expect(await screen.findByDisplayValue(JOB_DESCRIPTION)).toBeInTheDocument();
    expect(screen.getByText(/give it a read, edit if needed, then analyze/i)).toBeInTheDocument();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
    await vi.waitFor(async () =>
      expect(await getJobContext(1)).toMatchObject({
        jobDescription: JOB_DESCRIPTION,
        source: 'scraped',
      }),
    );
  });

  it('never overwrites text entered while a scrape is still pending', async () => {
    await stubChrome({ tabUrl: 'https://example.com/jobs/1', profile, jobPageData: null });
    const scrape = deferred<PostingReadOutcome>();
    render(<AutofillHarness readPosting={() => scrape.promise} />);
    const textarea = await screen.findByLabelText('Job description');

    fireEvent.click(screen.getByRole('button', { name: 'Extract job posting' }));
    fireEvent.change(textarea, { target: { value: 'My manually pasted description' } });
    scrape.resolve({
      status: 'success',
      candidate: { text: 'Late scraped description', score: 100, source: 'dom' },
    });

    await vi.waitFor(() => expect(textarea).toHaveValue('My manually pasted description'));
    expect(screen.queryByDisplayValue('Late scraped description')).not.toBeInTheDocument();
  });

  it('keeps scrape failure recoverable through manual paste', async () => {
    await stubChrome({ tabUrl: 'https://example.com/jobs/1', profile, jobPageData: null });
    render(<AutofillHarness readPosting={() => Promise.resolve({ status: 'not-found' })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Extract job posting' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/paste it in instead/i);
    fireEvent.change(screen.getByLabelText('Job description'), {
      target: { value: 'Manual fallback description' },
    });
    expect(screen.getByRole('button', { name: 'Analyze' })).not.toBeDisabled();
  });

  it('turns an unexpected frame-reader failure into the reload-or-paste fallback', async () => {
    await stubChrome({ tabUrl: 'https://example.com/jobs/1', profile, jobPageData: null });
    render(<AutofillHarness readPosting={() => Promise.reject(new Error('Chrome API failed'))} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Extract job posting' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/reload it to reconnect/i);
  });

  it('retains a scraped Ashby description from Overview to Application and analyzes against the posting URL', async () => {
    const overviewUrl = 'https://jobs.ashbyhq.com/acme/job-id';
    const { navigate, sendMessage } = await stubChrome({
      tabUrl: overviewUrl,
      tabId: 1,
      profile,
      jobPageData: null,
    });
    await setJobContext(1, overviewUrl, JOB_DESCRIPTION, 'scraped');
    render(<AutofillHarness />);
    expect(await screen.findByLabelText('Job description')).toHaveValue(JOB_DESCRIPTION);

    act(() => navigate(1, `${overviewUrl}/application`));

    expect(await screen.findByLabelText('Job description')).toHaveValue(JOB_DESCRIPTION);
    expect(screen.getByText(/still using the posting djobi pulled earlier/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[0]![0]!).toMatchObject({
      tabUrl: overviewUrl,
      jobDescription: JOB_DESCRIPTION,
    });
  });

  it('warns without blocking Fill when a retained run reaches application questions that were absent on Overview', async () => {
    const overviewUrl = 'https://jobs.ashbyhq.com/acme/job-id';
    const { navigate } = await stubChrome({
      tabUrl: overviewUrl,
      tabId: 1,
      profile,
      jobPageData: null,
    });
    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    act(() => navigate(1, `${overviewUrl}/application`));
    // Explicitly optional — the shared fixture is required, since only required questions are
    // drafted, and this case is about the optional wording.
    await reportDetectedPage(1, 0, { fields: [{ ...questionField, required: false }] });

    // An optional question is counted but deliberately not named — see the required case below,
    // which is the one worth reading the list for.
    expect(await screen.findByText(/1 optional question won't be filled/i)).toBeInTheDocument();
    // The warning is advisory: Fill still writes every field that does have a reviewed answer.
    expect(screen.getByRole('button', { name: 'Fill form' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));

    await vi.waitFor(() => expect(screen.queryByText(/won't be filled/i)).not.toBeInTheDocument());
    // The warning clears the moment Re-analyze is clicked, so wait for the replacement run rather
    // than the warning: Fill is offered again only once the new analysis has actually landed.
    expect(await screen.findByRole('button', { name: 'Fill form' })).not.toBeDisabled();
  });

  it('names the required questions Fill will leave blank, and only those', async () => {
    const overviewUrl = 'https://jobs.ashbyhq.com/acme/job-id';
    const { navigate } = await stubChrome({
      tabUrl: overviewUrl,
      tabId: 1,
      profile,
      jobPageData: null,
    });
    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    act(() => navigate(1, `${overviewUrl}/application`));
    await reportDetectedPage(1, 0, {
      fields: [
        {
          ...questionField,
          id: 'f-visa',
          label: 'Do you require visa sponsorship?',
          required: true,
        },
        { ...questionField, id: 'f-start', label: 'When can you start?', required: true },
        // Explicitly optional — the shared fixture is required, since only required questions are
        // drafted, and this case needs one of each.
        { ...questionField, required: false },
      ],
    });

    expect(await screen.findByText(/2 required questions won't be filled/i)).toBeInTheDocument();
    expect(screen.getByText('Do you require visa sponsorship?')).toBeInTheDocument();
    expect(screen.getByText('When can you start?')).toBeInTheDocument();
    // The optional one is not named — the list exists to show what blocks a submission.
    expect(screen.queryByText(questionField.label)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill form' })).not.toBeDisabled();
  });

  it('leaves the paste box empty even when a form is detected, and keeps Analyze disabled until something is pasted', async () => {
    // Detecting the form says nothing about the posting: the application page is a different page
    // from the job ad, which is why the scrape it used to be pre-filled from was dropped.
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<AutofillHarness />);

    expect(await screen.findByRole('button', { name: 'Analyze' })).toBeDisabled();
    expect(screen.getByPlaceholderText(/paste the job description/i)).toHaveValue('');
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(0);
  });

  it('keeps Analyze disabled when Chrome has not exposed the active tab URL', async () => {
    const { sendMessage } = await stubChrome({ tabUrl: null, profile, jobPageData: null });

    render(<AutofillHarness />);
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

    render(<AutofillHarness />);
    const textarea = await screen.findByPlaceholderText(/paste the job description/i);
    fireEvent.change(textarea, { target: { value: 'Pasted job description text.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[0]![0]!).toEqual({
      type: 'START_ANALYSIS',
      tabId: 1,
      tabUrl: 'https://example.com',
      profile,
      jobDescription: 'Pasted job description text.',
      force: false,
    });
  });

  it('disables "Analyze" when there is nothing to analyze yet (no paste, no detected job page)', async () => {
    await stubChrome({ tabUrl: 'https://example.com', profile, jobPageData: null });

    render(<AutofillHarness />);

    expect(await screen.findByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('sends the pasted job description with START_ANALYSIS', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      tabId: 1,
      profile,
      jobPageData,
    });

    render(<AutofillHarness />);
    await screen.findByRole('button', { name: 'Analyze' });

    await clickAnalyze('Pasted job description text.');

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[0]![0]!).toEqual(
      expect.objectContaining({
        type: 'START_ANALYSIS',
        jobDescription: 'Pasted job description text.',
      }),
    );
  });

  it('shows an editable review once analysis succeeds', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<AutofillHarness />);
    await clickAnalyze();

    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill form' })).toBeInTheDocument();
  });

  it('reminds the user to review the tailored resume before filling', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<AutofillHarness />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await clickAnalyze();

    expect(await screen.findByRole('note')).toHaveTextContent(
      "Read your tailored resume before you fill the form. Check every bullet, and change anything that doesn't sound like your actual experience.",
    );
  });

  it('reveals a job-description editor holding the analyzed text when "Edit job description" is clicked on the review screen', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));

    expect(screen.getByLabelText('Job description')).toHaveValue(JOB_DESCRIPTION);
  });

  it('disables "Re-analyze" when the review-screen editor is cleared to empty, rather than silently analyzing blank text', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
    });

    render(<AutofillHarness />);
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

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    fireEvent.change(screen.getByDisplayValue(JOB_DESCRIPTION), {
      target: { value: 'Pasted job description text.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));

    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(2));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[1]![0]!).toMatchObject({
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

    render(<AutofillHarness />);
    await clickAnalyze();

    await screen.findByText('Something went wrong analyzing this job posting.');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Senior Engineer at Acme');
  });

  it('stands down optimistic analysis and reports an immediate START delivery failure', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      dispatchFailures: ['Could not establish connection.', null],
    });

    render(<AutofillHarness />);
    await clickAnalyze();

    await screen.findByText('Something went wrong analyzing this job posting.');
    expect(
      screen.getByText("djobi couldn't finish that just now. Try again in a moment."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Senior Engineer at Acme');
  });

  it('classifies the delivery failure, not the failure the previous run left on the stored run', async () => {
    // The two classifications are separate: a delivery failure belongs to the command this panel
    // just sent and is never written to the run. Reading the failure off the run instead is how a
    // retry that never left the panel reported the previous attempt's classification.
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      analysisFailures: ['backend unreachable'],
      dispatchFailures: [null, 'Could not establish connection.'],
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Something unexpected went wrong. Try again.');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText("djobi couldn't finish that just now. Try again in a moment.");
    expect(
      screen.queryByText('Something unexpected went wrong. Try again.'),
    ).not.toBeInTheDocument();
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
          stage: 'onsite' as const,
          createdAt: '2026-08-03T10:00:00.000Z',
        },
      ],
    });

    render(<AutofillHarness />);
    await clickAnalyze();

    await screen.findByText(/you already applied to this job on august 3, 2026/i);
    // The stage is the half that says whether re-applying is even sensible: a live process reads
    // very differently from a rejection, and a date alone reports neither.
    await screen.findByText('Senior Engineer at Acme · Onsite');
    // The review never appears — the point of the guard is that no analysis ran at all.
    expect(screen.queryByRole('button', { name: 'Edit job description' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze and apply anyway' }));

    await screen.findByText('Senior Engineer at Acme');
    await vi.waitFor(() => expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(2));
    expect(callsOfType(sendMessage, 'START_ANALYSIS')[1]![0]!).toMatchObject({ force: true });
  });

  it('says how many times a repeatedly-applied-to job was applied for', async () => {
    const application = {
      id: 'a',
      company: 'Acme',
      roleTitle: 'Senior Engineer',
      stage: 'applied' as const,
    };
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      existingApplications: [
        { ...application, createdAt: '2026-08-03T10:00:00.000Z' },
        { ...application, createdAt: '2026-07-02T10:00:00.000Z' },
      ],
    });

    render(<AutofillHarness />);
    await clickAnalyze();

    // A single date would hide the repeat entirely.
    await screen.findByText(
      /already applied to this job 2 times, most recently on august 3, 2026/i,
    );
  });

  it('renders a stable model-output failure without exposing raw provider details', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      analysisFailures: [
        new HttpError(
          'http',
          '/answer-questions',
          'POST /answer-questions failed (500): report_answers did not produce a tool call.',
          500,
          { backendCode: 'invalid-model-output' },
        ),
      ],
    });

    render(<AutofillHarness />);
    await clickAnalyze();

    await screen.findByText('Something went wrong analyzing this job posting.');
    expect(
      screen.getByText("The AI came back with something djobi couldn't use. Try again."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/report_answers did not produce a tool call/),
    ).not.toBeInTheDocument();
  });

  it('tells the candidate to sign in again on a 401, rather than a generic failure', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      analysisFailures: [
        new HttpError('http', '/extract-job', 'GET /extract-job failed (401)', 401),
      ],
    });

    render(<AutofillHarness />);
    await clickAnalyze();

    await screen.findByText('Something went wrong analyzing this job posting.');
    expect(
      screen.getByText(
        "You've been signed out. Sign in again from the extension options, then retry.",
      ),
    ).toBeInTheDocument();
  });

  it('does not expose raw infrastructure details from a failed save', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      saveFailures: ['POST /applications failed (500): db unreachable'],
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save application' }));

    await screen.findByText('Something unexpected went wrong. Try again.');
    expect(screen.queryByText(/db unreachable/)).not.toBeInTheDocument();
  });

  it('warns that a temporary save failure may already have completed before offering a retry', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      dispatchFailures: [null, null, 'Could not establish connection.'],
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save application' }));

    await screen.findByText(
      'The save may have gone through. Check the dashboard before trying again.',
    );
  });

  it('fills the form without saving until "Save application" is clicked', async () => {
    const { sendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/Save the application when you're ready/);
    // Naming the run is what stops a command delivered after a re-analysis from filling a
    // different posting's form — see `background/runClaim.ts`.
    const filledRunId = (await getPipelineRun(1))!.runId;
    expect(callsOfType(sendMessage, 'START_FILL')[0]![0]!).toEqual({
      type: 'START_FILL',
      tabId: 1,
      profile,
      expectedRunId: filledRunId,
    });
    expect(callsOfType(sendMessage, 'START_SAVE_APPLICATION')).toHaveLength(0);

    // Save comes first in the footer once filling has happened: it is the step the candidate is on,
    // and the button under it offers a *repeat* of the one they just took ("Fill form again").
    const footerButtons = screen
      .getAllByRole('button')
      .filter((button) => button.closest('.panel-footer'))
      .map((button) => button.textContent);
    expect(footerButtons).toEqual(['Save application', 'Fill form again']);

    fireEvent.click(screen.getByRole('button', { name: 'Save application' }));
    const savedConfirmation = await screen.findByText('Application saved.');
    expect(savedConfirmation.closest('[role="status"]')).toHaveClass('compact');
    expect(screen.queryByText(/Save the application when you're ready/)).not.toBeInTheDocument();
    expect(callsOfType(sendMessage, 'START_SAVE_APPLICATION')[0]![0]!).toEqual({
      type: 'START_SAVE_APPLICATION',
      tabId: 1,
      expectedRunId: filledRunId,
    });
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

    render(<AutofillHarness />);
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

    render(<AutofillHarness />);
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
    expect(callsOfType(sendMessage, 'START_FILL')).toHaveLength(2);
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

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/didn't take a value/);
    expect(screen.getByText('Referral code')).toBeInTheDocument();
    expect(screen.queryByText(/Filled 3 fields/)).not.toBeInTheDocument();
  });

  it('reports an unfilled required question once after a fill, not beside its own prediction', async () => {
    // Both banners can describe the same question: one predicts what Fill will skip, the other
    // reports what it did skip. Before the prediction was retired on a reported fill, an
    // application route that mounted its own screening questions listed them twice on one screen.
    const screeningQuestion: DetectedField = {
      ...questionField,
      id: 'f-sponsorship',
      label: 'Will you now or in the future require immigration sponsorship?',
      required: true,
    };
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData: { ...jobPageData, fields: [...jobPageData.fields, screeningQuestion] },
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    expect(await screen.findByText(/1 required question won't be filled/i)).toBeInTheDocument();
    expect(screen.getAllByText(screeningQuestion.label)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/didn't take a value/);
    // The prediction is gone; the page's own account of the fill is the only list left.
    expect(screen.queryByText(/won't be filled/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(screeningQuestion.label)).toHaveLength(1);
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

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/found no form fields on this page/);
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

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/kept none of the values written into it/);
    expect(screen.queryByText(/found no form fields on this page/)).not.toBeInTheDocument();
  });

  it('warns when no frame answered instead of rendering a confident success', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      pageDoesNotAnswer: true,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    await screen.findByText(/djobi can't confirm what was filled/i);
    expect(screen.queryByText(/Save the application when you're ready/)).not.toBeInTheDocument();
  });

  it('ignores extra clicks on "Fill form" while a fill is already in flight', async () => {
    const { sendMessage, resolveFill } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      holdFill: true,
    });

    render(<AutofillHarness />);
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

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save application' }));

    await screen.findByText('Something went wrong saving the application.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Application saved.');
  });

  it('resets to the bootstrap screen when the active tab changes, so the panel (which survives tab switches) never shows a stale review for the previous tab', async () => {
    const { activate } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    activate(2);

    await screen.findByRole('button', { name: 'Analyze' });
    expect(screen.queryByText('Senior Engineer at Acme')).not.toBeInTheDocument();
  });

  it('removes the old review and Fill/Save controls immediately on same-tab navigation, before storage cleanup resolves', async () => {
    const { navigate, sessionStorage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });
    render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Fill form' }));
    await screen.findByRole('button', { name: 'Save application' });

    const storageClear = deferred<void>();
    sessionStorage.session.remove = vi.fn(() => storageClear.promise);
    void clearTabState(1);
    act(() => navigate(1, 'https://boards.greenhouse.io/acme/jobs/2'));

    expect(screen.queryByText('Senior Engineer at Acme')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fill form/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save application' })).not.toBeInTheDocument();
    expect(sessionStorage.session.remove).not.toHaveResolved();
    storageClear.resolve();
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

    const first = render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');
    fireEvent.change(screen.getByDisplayValue('Draft answer.'), {
      target: { value: 'Edited answer.' },
    });
    // Wait for the edit to reach the store, or reopening races the write it's meant to restore.
    await vi.waitFor(async () =>
      expect((await getPipelineRun(1))?.answers[0]!.answer).toBe('Edited answer.'),
    );
    first.unmount(); // simulates the panel closing

    const { sendMessage: secondSendMessage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
      sessionStorage, // same underlying chrome.storage.session — simulates reopening the panel
    });
    render(<AutofillHarness />); // simulates reopening the panel

    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Edited answer.')).toBeInTheDocument();
    expect(callsOfType(secondSendMessage, 'START_ANALYSIS')).toHaveLength(0); // rehydrated, not re-analyzed
  });

  it('disables persisted-data editors while saving so the saved snapshot cannot lag the display', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
    });
    render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Fill form' }));
    await screen.findByRole('button', { name: 'Save application' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    const current = await getPipelineRun(1);

    await act(async () => {
      await patchPipelineRun(1, current!.runId, { status: 'saving' });
    });

    expect(screen.getByDisplayValue('Draft answer.')).toBeDisabled();
    expect(screen.getByLabelText('Job description')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeDisabled();
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

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');
    expect(screen.getByDisplayValue('Draft answer.')).toBeInTheDocument();

    // Simulates background/applicationPipeline.ts patching the store directly, independent of this
    // mounted panel's own writes.
    const run = await getPipelineRun(1);
    await patchPipelineRun(1, run!.runId, {
      answers: [{ ...answers[0]!, answer: 'Updated from elsewhere.' }],
    });

    await screen.findByDisplayValue('Updated from elsewhere.');
  });

  it('shows a "Preview tailored resume" button on the review screen once analysis succeeds', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    expect(screen.getByRole('button', { name: 'Preview tailored resume' })).toBeInTheDocument();
  });

  it('renders the tailored resume PDF in a preview when "Preview tailored resume" is clicked', async () => {
    const renderResumePdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70]).buffer);
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      renderResumePdf,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));

    const frame = await screen.findByTitle('Tailored resume');
    expect(frame).toHaveAttribute('src', 'blob:resume-preview');
    // What the tab asked for, not which URL carried it: projecting the Profile down to the fields
    // the PDF needs is `httpBackendClient`'s job, and is asserted where that adapter is tested.
    expect(renderResumePdf).toHaveBeenCalledWith(profile, tailoredResume);
  });

  it('edits a tailored resume bullet on the review screen and checkpoints it to the run store', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    // The fake backend's `tailorResume` always answers with the neutral, bulletless fixture — real
    // bullet content is injected the same way `background/applicationPipeline.ts` itself would
    // checkpoint it, so this exercises the actual review -> store round trip rather than a
    // hand-rolled substitute for it.
    const analyzed = await getPipelineRun(1);
    await patchPipelineRun(1, analyzed!.runId, {
      tailoredResume: {
        skills: [],
        workExperience: [
          {
            company: 'Acme',
            title: 'Senior Engineer',
            startDate: '2022-01',
            endDate: null,
            bullets: ['Built the thing'],
          },
        ],
      },
    });

    fireEvent.click(await screen.findByText('Review resume bullets'));
    fireEvent.change(screen.getByLabelText('Role 1 bullet 1'), {
      target: { value: 'Built the thing end to end' },
    });

    await vi.waitFor(async () =>
      expect((await getPipelineRun(1))?.tailoredResume?.workExperience[0]!.bullets).toEqual([
        'Built the thing end to end',
      ]),
    );
  });

  it('clears the previous resume preview when re-analysis starts on the same page', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      renderResumePdf: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));
    await screen.findByTitle('Tailored resume');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));

    expect(screen.queryByTitle('Tailored resume')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:resume-preview');
  });

  it('keeps the resume preview when a Re-analyze that cannot run is clicked', async () => {
    const overviewUrl = 'https://jobs.ashbyhq.com/acme/job-id';
    const { navigate, sendMessage } = await stubChrome({
      tabUrl: overviewUrl,
      tabId: 1,
      profile,
      jobPageData: null,
      renderResumePdf: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByText('Senior Engineer at Acme');

    // The unfilled-questions notice carries the one Re-analyze that is offered whatever the Job
    // Description says — the editor's is disabled on an empty one. Rendering the PDF is expensive
    // enough that dropping it for an analysis that never starts is a real cost to the candidate.
    act(() => navigate(1, `${overviewUrl}/application`));
    await reportDetectedPage(1, 0, { fields: [{ ...questionField, required: false }] });
    await screen.findByText(/1 optional question won't be filled/i);

    fireEvent.click(screen.getByRole('button', { name: 'Preview tailored resume' }));
    await screen.findByTitle('Tailored resume');

    fireEvent.click(screen.getByRole('button', { name: 'Edit job description' }));
    fireEvent.change(screen.getByDisplayValue(JOB_DESCRIPTION), { target: { value: '' } });
    const [noticeReanalyze, editorReanalyze] = screen.getAllByRole('button', {
      name: 'Re-analyze',
    });
    expect(editorReanalyze).toBeDisabled();
    fireEvent.click(noticeReanalyze!);

    expect(screen.getByTitle('Tailored resume')).toBeInTheDocument();
    expect(callsOfType(sendMessage, 'START_ANALYSIS')).toHaveLength(1);
  });

  it('shows an error message when the resume PDF fails to render', async () => {
    const renderResumePdf = () => Promise.reject(new Error('render failed'));
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      renderResumePdf,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't build the preview/i);
  });

  it('ignores a pending resume preview completion after same-tab navigation', async () => {
    const preview = deferred<ArrayBuffer>();
    const renderResumePdf = () => preview.promise;
    const { navigate } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      renderResumePdf,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));
    act(() => navigate(1, 'https://boards.greenhouse.io/acme/jobs/2'));
    await act(async () => preview.resolve(new Uint8Array([37, 80, 68, 70]).buffer));

    expect(screen.queryByTitle('Tailored resume')).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('revokes a preview blob if it becomes stale while the completion is being applied', async () => {
    const renderResumePdf = async () => new Uint8Array([37, 80, 68, 70]).buffer;
    const { navigate } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      renderResumePdf,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    // Navigating from inside `createObjectURL` is the point: it lands the invalidation in the one
    // window between the blob existing and the state that owns it being set.
    vi.mocked(URL.createObjectURL).mockImplementation(() => {
      navigate(1, 'https://boards.greenhouse.io/acme/jobs/2');
      return 'blob:stale-resume-preview';
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));

    await vi.waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stale-resume-preview'),
    );
    expect(screen.queryByTitle('Tailored resume')).not.toBeInTheDocument();
  });

  it('ignores a pending resume preview rejection after navigation', async () => {
    const preview = deferred<ArrayBuffer>();
    const renderResumePdf = () => preview.promise;
    const { navigate } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      renderResumePdf,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));
    act(() => navigate(1, 'https://boards.greenhouse.io/acme/jobs/2'));
    await act(async () => preview.reject(new Error('stale failure')));

    expect(screen.queryByText(/couldn't build the preview/i)).not.toBeInTheDocument();
  });

  it('ignores a pending resume preview completion after unmount', async () => {
    const preview = deferred<ArrayBuffer>();
    const renderResumePdf = () => preview.promise;
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      renderResumePdf,
    });

    const panel = render(<AutofillHarness />);
    await clickAnalyze();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview tailored resume' }));
    panel.unmount();
    await act(async () => preview.resolve(new Uint8Array([37, 80, 68, 70]).buffer));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  /**
   * The Log tab itself is covered by `LogApplication.test.tsx`; what's tested here is only the
   * switch — that the two flows are reachable and that neither renders over the other.
   */

  it('offers no refinement for a constrained-choice question, which cannot take freeform prose', async () => {
    const sponsorshipField: DetectedField = {
      id: 'f-sponsorship',
      label: 'Will you require sponsorship?',
      inputType: 'select',
      selector: '#sponsorship-field',
      category: 'question',
      required: false,
      elementRole: 'native',
      options: [
        { label: 'Yes', selector: null },
        { label: 'No', selector: null },
      ],
    };
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData: { fields: [sponsorshipField] },
      tabId: 1,
    });

    render(<AutofillHarness />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });

    expect(screen.queryByRole('button', { name: 'Refine with AI' })).toBeNull();
  });
});
