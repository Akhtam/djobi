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

  it('deletes an application once the confirmation is given, and returns to the list', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });

    await user.click(screen.getByRole('button', { name: /^Delete application to/ }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));

    await screen.findByRole('heading', { level: 1, name: 'Applications' });
    expect(
      screen.queryByRole('combobox', { name: /Stage for Senior Frontend Engineer/ }),
    ).not.toBeInTheDocument();
  });

  it('asks first, and leaves the application in place when the ask is declined', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });

    await user.click(screen.getByRole('button', { name: /^Delete application to/ }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(screen.queryByRole('button', { name: 'Yes, delete' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' }),
    ).toBeInTheDocument();
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

  it('offers no way to edit a note — a correction is a new entry', async () => {
    // Deleting is supported; editing is not, and the distinction is the point. A note you rewrite
    // in place is history you can no longer trust, while a note you remove is one you are saying
    // never belonged in the log.
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('deletes a note once the confirmation is given', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    const [first] = screen.getAllByRole('button', { name: /^Delete note/ });

    await user.click(first!);
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));

    await waitFor(() =>
      expect(screen.queryByText(/disagreed with a technical decision/)).not.toBeInTheDocument(),
    );
  });

  it('asks first, and leaves the note alone when the ask is declined', async () => {
    // One click from an irreversible delete is the wrong shape for an append-only log that exists
    // to still be there months later — so the button arms, and the second click commits.
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    const [first] = screen.getAllByRole('button', { name: /^Delete note/ });

    await user.click(first!);
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(screen.getByText(/disagreed with a technical decision/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes, delete' })).not.toBeInTheDocument();
  });

  it('arms only the note that was clicked', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    await user.click(screen.getAllByRole('button', { name: /^Delete note/ })[0]!);

    expect(screen.getAllByRole('button', { name: 'Yes, delete' })).toHaveLength(1);
  });

  it('names the note each delete button belongs to, so the log is operable without sight', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    // Three notes, three buttons, no two of them called the same thing.
    const names = screen
      .getAllByRole('button', { name: /^Delete note/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
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

/**
 * The posting the run actually analyzed, and what the resume had to show for its requirements.
 *
 * Both were already being written at every save (`raw_description`, `requirement_evidence`) and read
 * back nowhere outside the Analytics roll-up — the storage was paid for and bought nothing. These
 * are the tests for it being read where it answers a question about *this* application.
 */
describe('what the analysis read, and what it found', () => {
  beforeEach(() => {
    window.location.hash = '#/applications/app-brex';
  });

  it('shows the posting text the analysis was given, not the live page', async () => {
    // The point of keeping it: a job-board URL 404s within months of the role closing, and this is
    // then the only copy of what was applied to — and the only way to ask why extraction produced
    // what it did.
    const { user } = renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Posting' }));

    expect(screen.getByText(/We are looking for a Senior Frontend Engineer/)).toBeInTheDocument();
  });

  it('says the posting was not kept, for a row saved before it was stored', async () => {
    // Every row written before the column existed has `rawDescription: null`, and nothing
    // backfills one. An empty tab that explains itself is the honest rendering of that.
    const { user } = renderDashboard({ hash: '#/applications/app-sonar' });
    await screen.findByRole('heading', { name: /Sonar/ });
    await user.click(screen.getByRole('tab', { name: 'Posting' }));

    expect(screen.getByText(/saved before the posting text was kept/i)).toBeInTheDocument();
  });

  it('badges a requirement the resume could not evidence', async () => {
    renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });

    const requirement = screen
      .getByText('5+ years building production React applications')
      .closest('li')!;
    expect(requirement).toHaveTextContent('Unconfirmed');
  });

  it('leaves an evidenced requirement unbadged — the good case is the common one', async () => {
    renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });

    const requirement = screen.getByText('Experience with design systems at scale').closest('li')!;
    expect(requirement).not.toHaveTextContent('Evidenced');
  });

  it('names the profile bullet that was dropped from the resume, since that one is fixable', async () => {
    // `omitted-profile-evidence` is the verdict worth acting on: the evidence exists in the
    // Profile and this resume left it out, so the requirement reads unsupported to the employer
    // over a bullet the candidate has already written.
    renderDashboard();
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });

    const requirement = screen
      .getByText('Experience improving frontend performance at scale')
      .closest('li')!;
    expect(requirement).toHaveTextContent('Dropped from resume');
    expect(requirement).toHaveTextContent(/Reduced p99 checkout latency/);
  });

  it('badges nothing for a row saved before verdicts were computed', async () => {
    renderDashboard({ hash: '#/applications/app-sonar' });
    await screen.findByRole('heading', { name: /Sonar/ });

    expect(screen.getByText('Deep JVM experience').closest('li')).not.toHaveTextContent(
      /Unconfirmed|No evidence|Dropped from resume|Skill only/,
    );
  });
});
