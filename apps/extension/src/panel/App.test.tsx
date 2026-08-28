/**
 * The panel shell: Profile bootstrap, the tab switch, and the hand-off from a question card to the
 * Ask Tab.
 *
 * The flows themselves are tested where they live — `AutofillTab.test.tsx`, `LogApplication.test
 * .tsx`, `AskTab.test.tsx`. What is left here is what the shell actually owns, which is why this
 * module no longer runs the whole Application Pipeline to assert on a tab button.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import {
  JOB_DESCRIPTION,
  clickAnalyze,
  jobPageData,
  panelClient,
  profile,
  resetPanelTestEnv,
  stubChrome,
} from './panelTestHarness';

describe('panel App', () => {
  beforeEach(resetPanelTestEnv);

  it('prompts to set up a profile when none exists yet', async () => {
    const { openOptionsPage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile: null,
    });

    render(<App client={panelClient()} />);

    await screen.findByText('Set up your profile to get started.');
    fireEvent.click(screen.getByRole('button', { name: 'Open profile settings' }));
    expect(openOptionsPage).toHaveBeenCalled();
  });

  it('leaves loading after a profile request fails and retries successfully', async () => {
    const { openOptionsPage } = await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      profileFailures: ['backend unavailable', null],
    });

    render(<App client={panelClient()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load your profile/i);
    expect(screen.getByRole('button', { name: 'Open profile settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open profile settings' }));
    expect(openOptionsPage).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry loading profile' }));

    expect(await screen.findByRole('button', { name: 'Analyze' })).toBeInTheDocument();
    // Two asks, not two requests: the retry is the shell asking the client again, which is the
    // only fact this module owns.
    expect(panelClient().getProfile).toHaveBeenCalledTimes(2);
  });

  it('offers no tabs until a profile exists', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile: null });

    render(<App client={panelClient()} />);

    await screen.findByText('Set up your profile to get started.');
    expect(screen.queryByRole('button', { name: 'Log' })).not.toBeInTheDocument();
  });

  it('switches between autofilling and logging an application by hand', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App client={panelClient()} />);
    await screen.findByRole('button', { name: 'Analyze' });

    fireEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(await screen.findByRole('heading', { name: 'Log an application' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Analyze' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Autofill' }));

    expect(await screen.findByRole('button', { name: 'Analyze' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Log an application' })).not.toBeInTheDocument();
  });

  /**
   * Extracting a posting on the Log tab is a model call. Unmounting the tab on a switch threw the
   * result away, so glancing at the run in progress cost the candidate a re-paste and a re-extract.
   */

  it('keeps what was typed on the Log tab across a switch to Autofill and back', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App client={panelClient()} />);
    await screen.findByRole('button', { name: 'Analyze' });

    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    const posting = await screen.findByPlaceholderText(/Paste the posting/);
    fireEvent.change(posting, { target: { value: 'Staff Engineer at Globex.' } });

    fireEvent.click(screen.getByRole('button', { name: 'Autofill' }));
    await screen.findByRole('button', { name: 'Analyze' });
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(await screen.findByPlaceholderText(/Paste the posting/)).toHaveValue(
      'Staff Engineer at Globex.',
    );
  });

  /**
   * The footer belongs to the pipeline run, and a run can be mid-review while the candidate is on
   * the Log tab — a "Fill form" button over a form that has nothing to do with the open tab would
   * fill the page behind it.
   */

  it('keeps the run footer off the Log tab', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile, jobPageData });

    render(<App client={panelClient()} />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });

    fireEvent.click(screen.getByRole('button', { name: 'Log' }));

    expect(screen.queryByRole('button', { name: 'Fill form' })).not.toBeInTheDocument();
  });

  it('offers the Ask tab with no run at all — a question needs no job page to be worth answering', async () => {
    await stubChrome({ tabUrl: 'https://boards.greenhouse.io/acme/jobs/1', profile });

    render(<App client={panelClient()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask' }));

    expect(await screen.findByLabelText('Application question')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    // The pill describes the pipeline run, and there is no run on this tab for it to be about.
    expect(screen.queryByRole('status', { name: '' })).toBeNull();
  });

  it('hands a drafted answer to the Ask tab and writes the refinement back to its card', async () => {
    await stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profile,
      jobPageData,
      tabId: 1,
      chatReply: { reply: 'Shortened it.', revisedAnswer: 'A tighter answer.' },
    });

    render(<App client={panelClient()} />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });

    fireEvent.click(screen.getByRole('button', { name: 'Refine with AI' }));

    // Seeded with the question and its current draft, on the Ask tab. Both are scoped to the Ask
    // pane: the autofill pane stays mounted, so the same text is also on screen in the card it
    // came from.
    await screen.findByRole('button', { name: 'Send' });
    expect(document.querySelector('.ask-subject')?.textContent).toContain(
      'Why do you want to work here?',
    );
    expect(document.querySelector('.ask-context')?.textContent).toContain('Draft answer.');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Shorter.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Use this answer' }));

    fireEvent.click(screen.getByRole('button', { name: 'Autofill' }));
    expect(await screen.findByDisplayValue('A tighter answer.')).toBeInTheDocument();
  });
  it("reports the Fill Step's outcome in the header pill, which is the shell's own reading of the run", async () => {
    // The pill is the one thing the shell does with the run. It is suppressed on the other tabs,
    // because there is no run there for it to be about.
    await stubChrome({
      tabUrl: 'https://jobs.lever.co/acme/1/apply',
      profile,
      jobPageData,
      pageKeepsNothing: true,
    });

    render(<App client={panelClient()} />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    expect(await screen.findByText('Nothing filled')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(screen.queryByText('Nothing filled')).not.toBeInTheDocument();
  });

  it('moves the header pill with the tab it describes, from the click rather than from the store', async () => {
    // The pill, the tab body and the footer are three readings of one run, and they used to be
    // derived from two different things: the pill from the stored run, the body and footer from the
    // reconciled status. So for the whole gap between a click and the background's own write the
    // header said "Ready to fill" over a body that said "Filling…".
    const { resolveFill } = await stubChrome({
      tabUrl: 'https://jobs.lever.co/acme/1/apply',
      profile,
      jobPageData,
      holdFill: true,
    });

    render(<App client={panelClient()} />);
    await clickAnalyze();
    await screen.findByRole('button', { name: 'Fill form' });
    expect(screen.getByText('Ready to fill')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fill form' }));

    // Immediately, on the optimistic status alone — no storage round-trip has happened yet.
    expect(screen.getByText('Filling…')).toBeInTheDocument();
    expect(screen.queryByText('Ready to fill')).not.toBeInTheDocument();

    act(() => resolveFill());
    expect(await screen.findByText('Done')).toBeInTheDocument();
  });
});
