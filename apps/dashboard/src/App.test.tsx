/**
 * Whole-app tests, driven through `createFixtureDashboardClient`. No network is involved and no
 * component is mocked — the seam the fixture client sits on is the only substitution, which is
 * what it exists for.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createFixtureDashboardClient, type DashboardClient } from './lib/dashboardClient';
import { fixtureApplications } from './lib/fixtures';

function renderApp(client: DashboardClient = createFixtureDashboardClient(fixtureApplications)) {
  return { user: userEvent.setup(), ...render(<App client={client} />) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Tabs forward until `target` has focus. The stage picker sits behind the back link, the theme
 * toggle and the job-url link, and counting those is a test that breaks whenever the header
 * changes — what matters here is only that the control is reachable by keyboard at all.
 */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  for (let i = 0; i < 12 && document.activeElement !== target; i++) {
    await user.tab();
  }
  expect(target).toHaveFocus();
}

/** The list renders one card per application; each card's link is the role title. */
function cardFor(roleTitle: string): HTMLElement {
  return screen.getByRole('link', { name: roleTitle }).closest('li')!;
}

beforeEach(() => {
  window.location.hash = '#/';
});

describe('applications list', () => {
  it('renders a card per application once loaded', async () => {
    renderApp();

    expect(
      await screen.findByRole('link', { name: 'Senior Frontend Engineer' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Engineer|Product/ }).length).toBeGreaterThan(1);
  });

  it('summarises the count and how many are live', async () => {
    renderApp();
    expect(await screen.findByText(/7 applications · 3 in progress/)).toBeInTheDocument();
  });

  it('filters by stage', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.click(screen.getByRole('button', { name: /^Rejected/ }));

    expect(
      screen.getByRole('link', { name: 'Software Engineer, Developer Experience' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Senior Frontend Engineer' }),
    ).not.toBeInTheDocument();
  });

  it('filters by a search over company and role', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'ramp');

    expect(screen.getByRole('link', { name: 'Product Engineer' })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Senior Frontend Engineer' }),
    ).not.toBeInTheDocument();
  });

  it('says a filter matched nothing rather than looking like data loss', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'zzzz');

    expect(screen.getByText('No applications match that filter.')).toBeInTheDocument();
  });

  it('distinguishes an empty dataset from an over-narrow filter', async () => {
    renderApp(createFixtureDashboardClient([]));
    expect(await screen.findByText(/No applications yet/)).toBeInTheDocument();
  });

  it('leads with the company, not the role', async () => {
    renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    expect(within(cardFor('Senior Frontend Engineer')).getByText('Brex')).toBeInTheDocument();
  });

  it('does not show a note count on the card', async () => {
    renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    // app-brex has three notes; the count belonged on the detail page, not the list.
    expect(
      within(cardFor('Senior Frontend Engineer')).queryByText(/notes?$/),
    ).not.toBeInTheDocument();
  });

  it('opens the job posting in a new tab, without going to the detail page', async () => {
    renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    const posting = within(cardFor('Senior Frontend Engineer')).getByRole('link', {
      name: /Open the Brex job posting in a new tab/,
    });

    expect(posting).toHaveAttribute('href', 'https://boards.greenhouse.io/brex/jobs/4012');
    expect(posting).toHaveAttribute('target', '_blank');
    expect(posting).toHaveAttribute('rel', 'noreferrer');
    // It must not be the card's stretched link, which navigates to the detail page.
    expect(posting).not.toHaveAttribute('href', '#/applications/app-brex');
  });

  it('changes a stage from the card without navigating away', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Staff Engineer, Platform' });

    const select = screen.getByRole('combobox', { name: /Stage for Staff Engineer, Platform/ });
    await user.selectOptions(select, 'interviewing');

    await waitFor(() => expect(select).toHaveValue('interviewing'));
    // Still on the list.
    expect(screen.getByRole('searchbox', { name: 'Search company or role' })).toBeInTheDocument();
  });
});

describe('routing', () => {
  it('opens an application from its card link', async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole('link', { name: 'Senior Frontend Engineer' }));

    expect(
      await screen.findByRole('heading', { name: 'Senior Frontend Engineer' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Brex · Infrastructure · Remote (US)')).toBeInTheDocument();
  });

  it('loads a detail page cold from a deep link', async () => {
    window.location.hash = '#/applications/app-ramp';
    renderApp();

    expect(await screen.findByRole('heading', { name: 'Product Engineer' })).toBeInTheDocument();
  });

  it('shows the same brand header on both routes', async () => {
    renderApp();
    expect(
      await screen.findByRole('link', { name: 'djobi — all applications' }),
    ).toBeInTheDocument();

    window.location.hash = '#/applications/app-ramp';
    await screen.findByRole('heading', { name: 'Product Engineer' });

    expect(screen.getByRole('link', { name: 'djobi — all applications' })).toBeInTheDocument();
  });

  it('puts the back link inside the detail view, above the role title', async () => {
    window.location.hash = '#/applications/app-ramp';
    renderApp();

    const heading = await screen.findByRole('heading', { name: 'Product Engineer' });
    const back = screen.getByRole('link', { name: '← Applications' });

    // Not in the page header: it belongs to the record, not the chrome.
    expect(back.closest('header.page-header')).toBeNull();
    expect(back.closest('article.detail')).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING === 4: the heading comes after the link.
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('goes back to the list', async () => {
    window.location.hash = '#/applications/app-ramp';
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Product Engineer' });

    await user.click(screen.getByRole('link', { name: '← Applications' }));

    expect(await screen.findByRole('heading', { name: 'Applications' })).toBeInTheDocument();
  });

  it('reports an id that does not exist instead of rendering a blank page', async () => {
    window.location.hash = '#/applications/does-not-exist';
    renderApp();

    expect(await screen.findByText(/No application with that id/)).toBeInTheDocument();
  });
});

describe('application detail', () => {
  beforeEach(() => {
    window.location.hash = '#/applications/app-brex';
  });

  it('shows the current stage as the dropdown’s value', async () => {
    renderApp();
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    expect(picker).toHaveValue('interviewing');
  });

  it('advances the stage from the dropdown', async () => {
    const { user } = renderApp();
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'rejected');

    await waitFor(() => expect(picker).toHaveValue('rejected'));
  });

  it('reaches and operates the stage control by keyboard alone', async () => {
    const { user } = renderApp();
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    // A native select is why this is trivially true. The hand-built ARIA radiogroup this replaced
    // used a roving tabindex with no arrow-key handler, which left it focusable and inoperable.
    await tabTo(user, picker);
    await user.selectOptions(picker, 'applied');

    await waitFor(() => expect(picker).toHaveValue('applied'));
  });

  it('carries a stage change back to the list', async () => {
    const { user } = renderApp();
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
    renderApp();
    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });

    const notes = screen.getAllByRole('listitem').filter((li) => li.className === 'note');
    expect(notes[0]).toHaveTextContent(/disagreed with a technical decision/);
  });

  it('filters notes by category', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });

    await user.click(screen.getByRole('button', { name: /^Technical/ }));

    expect(screen.getByText(/debug a race in a React effect/)).toBeInTheDocument();
    expect(screen.queryByText(/Recruiter screen booked/)).not.toBeInTheDocument();
  });

  it('appends a note and clears only the text', async () => {
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });

    await user.click(screen.getByRole('radio', { name: 'Technical' }));
    const textarea = screen.getByRole('textbox', { name: 'Note' });
    await user.type(textarea, 'They asked about suspense boundaries.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByText('They asked about suspense boundaries.')).toBeInTheDocument();
    expect(textarea).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Technical' })).toBeChecked();
  });

  it('will not submit an empty note', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });

    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
  });

  it('offers no way to edit or delete a note', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });

    expect(screen.queryByRole('button', { name: /delete|remove|edit/i })).not.toBeInTheDocument();
  });

  it('says so when an application had no freeform questions', async () => {
    window.location.hash = '#/applications/app-sonar';
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Staff Engineer, Platform' });

    await user.click(screen.getByText('Drafted answers (0)'));
    expect(screen.getByText('This form had no freeform questions.')).toBeInTheDocument();
  });

  it('links out to the posting without leaking the referrer', async () => {
    renderApp();
    const link = await screen.findByRole('link', {
      name: /Open the Brex job posting in a new tab/,
    });

    expect(link).toHaveAttribute('href', 'https://boards.greenhouse.io/brex/jobs/4012');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  /**
   * Job-board URLs run long enough to push the record's own content off the first screen, so the
   * detail page shows the same pill the cards do and keeps the URL on the `title`.
   */
  it('does not print the raw job URL', async () => {
    window.location.hash = '#/applications/app-brex';
    renderApp();
    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });

    expect(
      screen.queryByText('https://boards.greenhouse.io/brex/jobs/4012'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the Brex job posting/ })).toHaveAttribute(
      'title',
      'https://boards.greenhouse.io/brex/jobs/4012',
    );
  });
});

describe('failures', () => {
  it('persists rapid stage changes in user action order while keeping the latest optimistic UI', async () => {
    type StageResult = Awaited<ReturnType<DashboardClient['updateStage']>>;
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const first = deferred<StageResult>();
    const second = deferred<StageResult>();
    const calls: string[] = [];
    const client: DashboardClient = {
      ...fixture,
      updateStage: (_id, stage) => {
        calls.push(stage);
        return stage === 'applied' ? first.promise : second.promise;
      },
    };
    window.location.hash = '#/applications/app-brex';

    const { user } = renderApp(client);
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'applied');
    await user.selectOptions(picker, 'rejected');

    expect(picker).toHaveValue('rejected');
    expect(calls).toEqual(['applied']);

    first.resolve({ id: 'app-brex', stage: 'applied' });
    await waitFor(() => expect(calls).toEqual(['applied', 'rejected']));
    expect(picker).toHaveValue('rejected');

    await act(async () => {
      second.resolve({ id: 'app-brex', stage: 'rejected' });
    });

    expect(picker).toHaveValue('rejected');
    expect(calls.at(-1)).toBe('rejected');
  });

  it('starts a newer queued stage after the first fails without reverting the latest UI', async () => {
    type StageResult = Awaited<ReturnType<DashboardClient['updateStage']>>;
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const first = deferred<StageResult>();
    const second = deferred<StageResult>();
    const calls: string[] = [];
    const client: DashboardClient = {
      ...fixture,
      updateStage: (_id, stage) => {
        calls.push(stage);
        return stage === 'applied' ? first.promise : second.promise;
      },
    };
    window.location.hash = '#/applications/app-brex';

    const { user } = renderApp(client);
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'applied');
    await user.selectOptions(picker, 'rejected');
    expect(calls).toEqual(['applied']);

    first.reject(new Error('stale failure'));
    await waitFor(() => expect(calls).toEqual(['applied', 'rejected']));

    expect(picker).toHaveValue('rejected');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      second.resolve({ id: 'app-brex', stage: 'rejected' });
    });

    expect(picker).toHaveValue('rejected');
    expect(calls.at(-1)).toBe('rejected');
  });

  it('reverts an optimistic stage change and says why', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const failing: DashboardClient = {
      ...fixture,
      updateStage: () => Promise.reject(new Error('Phase 7 has not built this route')),
    };
    window.location.hash = '#/applications/app-brex';

    const { user } = renderApp(failing);
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });
    await user.selectOptions(picker, 'rejected');

    expect(await screen.findByRole('alert')).toHaveTextContent('Phase 7 has not built this route');
    // The change is undone, not left showing a value the server rejected.
    await waitFor(() => expect(picker).toHaveValue('interviewing'));
  });

  it('keeps the typed note when the save fails, rather than throwing the user’s text away', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const failing: DashboardClient = {
      ...fixture,
      addNote: () => Promise.reject(new Error('Phase 7 has not built this route')),
    };
    window.location.hash = '#/applications/app-brex';

    const { user } = renderApp(failing);
    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });

    const textarea = screen.getByRole('textbox', { name: 'Note' });
    await user.type(textarea, 'Worth not losing.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Phase 7 has not built this route');
    expect(textarea).toHaveValue('Worth not losing.');
  });

  it('does not undo a different write that already succeeded', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    type StageResult = Awaited<ReturnType<DashboardClient['updateStage']>>;
    const brexWrite = deferred<StageResult>();
    const calls: string[] = [];
    const failing: DashboardClient = {
      ...fixture,
      updateStage: (id, stage) => {
        calls.push(id);
        return id === 'app-brex' ? brexWrite.promise : fixture.updateStage(id, stage);
      },
    };

    const { user } = renderApp(failing);
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    const brex = screen.getByRole('combobox', { name: /Stage for Senior Frontend Engineer/ });
    const sonar = screen.getByRole('combobox', { name: /Stage for Staff Engineer, Platform/ });

    await user.selectOptions(brex, 'rejected');
    await user.selectOptions(sonar, 'interviewing');

    // A pending write for one application does not block another application's queue.
    expect(calls).toEqual(['app-brex', 'app-sonar']);
    await waitFor(() => expect(sonar).toHaveValue('interviewing'));

    brexWrite.reject(new Error('nope'));
    // The failing write reverts its own record...
    await waitFor(() => expect(brex).toHaveValue('interviewing'));
    // ...and leaves the one that succeeded alone.
    expect(sonar).toHaveValue('interviewing');
  });

  it('clears a previous failure when the next write is attempted', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    let failNext = true;
    const flaky: DashboardClient = {
      ...fixture,
      updateStage: (id, stage) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('transient'));
        }
        return fixture.updateStage(id, stage);
      },
    };
    window.location.hash = '#/applications/app-brex';

    const { user } = renderApp(flaky);
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'rejected');
    expect(await screen.findByRole('alert')).toHaveTextContent('transient');

    await user.selectOptions(picker, 'rejected');

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('reports a failure to load rather than showing an empty list', async () => {
    renderApp({
      listApplications: () => Promise.reject(new Error('backend is not running')),
      updateStage: () => Promise.reject(new Error('unused')),
      addNote: () => Promise.reject(new Error('unused')),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('backend is not running');
  });
});
