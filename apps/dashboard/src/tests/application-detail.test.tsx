/**
 * The detail page for one application: the stage picker, notes, and the job-posting link. Failure
 * and rollback behavior for these same controls lives in `application-mutations` instead — this
 * file is the happy-path UI.
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderDashboard, tabTo } from './test-utils';

describe('application detail', () => {
  beforeEach(() => {
    window.location.hash = '#/applications/app-brex';
  });

  it('shows the current stage as the dropdown’s value', async () => {
    renderDashboard();
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    expect(picker).toHaveValue('onsite');
  });

  it('advances the stage from the dropdown', async () => {
    const { user } = renderDashboard();
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'rejected');

    await waitFor(() => expect(picker).toHaveValue('rejected'));
  });

  it('reaches and operates the stage control by keyboard alone', async () => {
    const { user } = renderDashboard();
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    // A native select is why this is trivially true. The hand-built ARIA radiogroup this replaced
    // used a roving tabindex with no arrow-key handler, which left it focusable and inoperable.
    await tabTo(user, picker);
    await user.selectOptions(picker, 'applied');

    await waitFor(() => expect(picker).toHaveValue('applied'));
  });

  it('carries a stage change back to the list', async () => {
    const { user } = renderDashboard();
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });
    await user.selectOptions(picker, 'rejected');
    await waitFor(() => expect(picker).toHaveValue('rejected'));

    await user.click(screen.getByRole('link', { name: '← Applications' }));

    const select = await screen.findByRole('combobox', {
      name: /Stage for Senior Frontend Engineer/,
    });
    expect(select).toHaveValue('rejected');
  });

  it('lists notes newest first', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    const notes = screen.getAllByRole('listitem').filter((li) => li.className === 'note');
    expect(notes[0]).toHaveTextContent(/disagreed with a technical decision/);
  });

  it('filters notes by category', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    await user.click(screen.getByRole('button', { name: /^Technical/ }));

    expect(screen.getByText(/debug a race in a React effect/)).toBeInTheDocument();
    expect(screen.queryByText(/Recruiter screen booked/)).not.toBeInTheDocument();
  });

  it('appends a note and clears only the text', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    await user.click(screen.getByRole('radio', { name: 'Technical' }));
    const textarea = screen.getByRole('textbox', { name: 'Note' });
    await user.type(textarea, 'They asked about suspense boundaries.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByText('They asked about suspense boundaries.')).toBeInTheDocument();
    expect(textarea).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Technical' })).toBeChecked();
  });

  it('will not submit an empty note', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
  });

  it('offers no way to edit or delete a note', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    expect(screen.queryByRole('button', { name: /delete|remove|edit/i })).not.toBeInTheDocument();
  });

  it('says so when an application had no freeform questions', async () => {
    const { user } = renderDashboard({ hash: '#/applications/app-sonar' });
    await screen.findByRole('heading', { name: 'Sonar · Geneva, Switzerland' });

    await user.click(screen.getByRole('tab', { name: 'Materials' }));
    expect(screen.getByText('Drafted answers (0)')).toBeInTheDocument();
    expect(screen.getByText('This form had no freeform questions.')).toBeInTheDocument();
  });

  it('links out to the posting without leaking the referrer', async () => {
    renderDashboard();
    const link = await screen.findByRole('link', {
      name: /Open the Brex job posting in a new tab/,
    });

    expect(link).toHaveAttribute('href', 'https://boards.greenhouse.io/brex/jobs/4012');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  /**
   * Job-board URLs run long enough to push the record's own content off the first screen, so the
   * detail page shows the same pill the rows do and keeps the URL on the `title`.
   */
  it('does not print the raw job URL', async () => {
    renderDashboard({ hash: '#/applications/app-brex' });
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });

    expect(
      screen.queryByText('https://boards.greenhouse.io/brex/jobs/4012'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the Brex job posting/ })).toHaveAttribute(
      'title',
      'https://boards.greenhouse.io/brex/jobs/4012',
    );
  });
});
