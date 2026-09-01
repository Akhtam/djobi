/**
 * Whole-app tests, driven through `createFixtureDashboardClient`. No network is involved and no
 * component is mocked — the seam the fixture client sits on is the only substitution, which is
 * what it exists for.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpError } from '@djobi/http-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createFixtureDashboardClient, type DashboardClient } from './lib/dashboardClient';
import { fixtureApplications, fixtureProfile } from './lib/fixtures';
import { PAGE_SIZE } from './lib/useHashRoute';

function renderApp(client: DashboardClient = createFixtureDashboardClient(fixtureApplications)) {
  return { user: userEvent.setup(), ...render(<App client={client} />) };
}

/**
 * `count` applications, numbered so each has a findable role title. The fixtures are seven rows —
 * enough to exercise filtering, not enough to reach a second batch of {@link PAGE_SIZE}.
 */
function manyApplications(count: number) {
  const [template] = fixtureApplications;
  return Array.from({ length: count }, (_, i) => ({
    ...structuredClone(template),
    id: `app-${i}`,
    roleTitle: `Engineer ${i}`,
    // Descending, so `Engineer 0` sorts first and the batches are in a predictable order.
    createdAt: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString(),
  }));
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

async function lowerAnalyticsMinimumToOne(user: ReturnType<typeof userEvent.setup>) {
  const decrease = await screen.findByRole('button', { name: 'Decrease minimum appearances' });
  for (let value = 5; value > 1; value--) await user.click(decrease);
}

/** The list renders one row per application; each row's detail link is the role title. */
function rowFor(roleTitle: string): HTMLElement {
  return screen.getByRole('link', { name: roleTitle }).closest('[data-application-row]')!;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.location.hash = '#/';
});

describe('landing page', () => {
  it('renders at the bare homepage without loading authenticated dashboard data', () => {
    window.location.hash = '';
    const client = createFixtureDashboardClient(fixtureApplications);
    const listApplications = vi.spyOn(client, 'listApplications');

    renderApp(client);

    expect(
      screen.getByRole('heading', { name: 'Apply with context. Follow up with clarity.' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open dashboard' })[0]).toHaveAttribute(
      'href',
      '/#/',
    );
    expect(screen.getByRole('navigation', { name: 'Landing page' })).toBeInTheDocument();
    expect(listApplications).not.toHaveBeenCalled();
  });

  it('offers product details in accessible disclosures', async () => {
    window.location.hash = '';
    const { user } = renderApp();
    const question = screen.getByText('Does djobi submit applications for me?');

    expect(question.closest('details')).not.toHaveAttribute('open');
    await user.click(question);

    expect(question.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/you review the page and submit/)).toBeInTheDocument();
  });

  it('switches to the dashboard on a hash-only navigation, with no document reload', async () => {
    window.location.hash = '';
    const client = createFixtureDashboardClient(fixtureApplications);
    renderApp(client);
    screen.getByRole('navigation', { name: 'Landing page' });

    act(() => {
      window.location.hash = '#/login';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Landing page' })).not.toBeInTheDocument();
  });

  it('leaves an in-page landing anchor on the landing page rather than switching to the dashboard', () => {
    window.location.hash = '';
    renderApp();
    screen.getByRole('navigation', { name: 'Landing page' });

    act(() => {
      window.location.hash = '#product';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(screen.getByRole('navigation', { name: 'Landing page' })).toBeInTheDocument();
  });
});

describe('applications list', () => {
  it('renders a row per application once loaded', async () => {
    renderApp();

    expect(
      await screen.findByRole('link', { name: 'Senior Frontend Engineer' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Engineer|Product/ }).length).toBeGreaterThan(1);
  });

  it('summarises the count and how many are live', async () => {
    renderApp();
    expect(await screen.findByText(/8 applications · 4 in progress/)).toBeInTheDocument();
  });

  it('renders the scan-first table columns and manual-log action', async () => {
    renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual(
      ['Company', 'Posting', 'Role', 'Source', 'Status', 'Applied'],
    );
    expect(screen.getByRole('button', { name: 'Log application' })).toBeInTheDocument();
    const row = rowFor('Senior Frontend Engineer');
    expect(within(row).getByText('Job posting')).toBeInTheDocument();
    expect(within(row).getByText('Greenhouse')).toBeInTheDocument();
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

  it('shows both kinds of rejection under the one Rejected pill', async () => {
    // There is no ATS-only pill by design. The kind still shows on each row's stage badge.
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.click(screen.getByRole('button', { name: /^Rejected/ }));

    // app-anthropic-manual is `rejected_ats`, app-vercel is `rejected`.
    expect(
      screen.getByRole('link', { name: 'Member of Technical Staff, Product' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Software Engineer, Developer Experience' }),
    ).toBeInTheDocument();
  });

  it('counts both rejections on the one pill', async () => {
    renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    // One `rejected` fixture and one `rejected_ats`.
    expect(screen.getByRole('button', { name: /^Rejected/ })).toHaveAccessibleName('Rejected2');
    expect(screen.queryByRole('button', { name: /ATS/ })).not.toBeInTheDocument();
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

  it('counts each stage within the company or role search', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'ramp');

    expect(screen.getByRole('button', { name: /^Applied/ })).toHaveAccessibleName('Applied0');
    expect(screen.getByRole('button', { name: /^Phone screen/ })).toHaveAccessibleName(
      'Phone screen1',
    );
    expect(screen.getByRole('button', { name: /^Onsite/ })).toHaveAccessibleName('Onsite0');
    expect(screen.getByRole('button', { name: /^Offer/ })).toHaveAccessibleName('Offer0');
    expect(screen.getByRole('button', { name: /^Rejected/ })).toHaveAccessibleName('Rejected0');
  });

  it('keeps the filters through opening an application and coming back', async () => {
    // The whole reason the filters live in the URL. `ApplicationsList` unmounts on the way to the
    // detail page, so anything held in its own state is gone by the time the user returns.
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'ramp');
    await user.click(screen.getByRole('link', { name: 'Product Engineer' }));

    const back = await screen.findByRole('link', { name: '← Applications' });
    expect(back).toHaveAttribute('href', '#/?q=ramp');

    await user.click(back);

    expect(await screen.findByRole('searchbox', { name: 'Search company or role' })).toHaveValue(
      'ramp',
    );
    expect(
      screen.queryByRole('link', { name: 'Senior Frontend Engineer' }),
    ).not.toBeInTheDocument();
  });

  it('renders the filters a deep link asks for', async () => {
    window.location.hash = '#/?q=ramp&stage=phone_screen';
    renderApp();

    expect(await screen.findByRole('link', { name: 'Product Engineer' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search company or role' })).toHaveValue('ramp');
    expect(screen.getByRole('button', { name: /^Phone screen/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.queryByRole('link', { name: 'Senior Frontend Engineer' }),
    ).not.toBeInTheDocument();
  });

  it('does not push a history entry per keystroke', async () => {
    // Filter changes replace the current entry; only opening an application pushes. Otherwise Back
    // would walk the user backwards through their own typing instead of leaving the list.
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });
    const before = window.history.length;

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'ramp');

    expect(window.location.hash).toBe('#/?q=ramp');
    expect(window.history.length).toBe(before);
  });

  it('reveals only the first batch, and offers the rest', async () => {
    renderApp(createFixtureDashboardClient(manyApplications(PAGE_SIZE + 5)));
    await screen.findByRole('link', { name: 'Engineer 0' });

    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE);
    expect(screen.queryByRole('link', { name: `Engineer ${PAGE_SIZE}` })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load 5 more' })).toBeInTheDocument();
    expect(screen.getByText(`Showing ${PAGE_SIZE} of ${PAGE_SIZE + 5}`)).toBeInTheDocument();
  });

  it('keeps what is already on screen when more is loaded', async () => {
    const { user } = renderApp(createFixtureDashboardClient(manyApplications(PAGE_SIZE + 5)));
    await screen.findByRole('link', { name: 'Engineer 0' });

    await user.click(screen.getByRole('button', { name: 'Load 5 more' }));

    // The point of Load more over paging: the first batch does not go anywhere.
    expect(screen.getByRole('link', { name: 'Engineer 0' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Engineer ${PAGE_SIZE}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load/ })).not.toBeInTheDocument();
  });

  it('offers no button when everything already fits', async () => {
    renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    expect(screen.queryByRole('button', { name: /Load/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
  });

  it('keeps the revealed rows through opening an application and coming back', async () => {
    const { user } = renderApp(createFixtureDashboardClient(manyApplications(PAGE_SIZE * 3)));
    await screen.findByRole('link', { name: 'Engineer 0' });

    await user.click(screen.getByRole('button', { name: `Load ${PAGE_SIZE} more` }));
    await user.click(screen.getByRole('link', { name: `Engineer ${PAGE_SIZE}` }));
    await user.click(await screen.findByRole('link', { name: '← Applications' }));

    expect(await screen.findByRole('link', { name: `Engineer ${PAGE_SIZE}` })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE * 2);
  });

  it('starts a freshly loaded document at the first batch, keeping the filters', async () => {
    // `?show=` is a place in a session, not an intent: a reload should not render hundreds of rows
    // nobody has asked for again. The filters are an intent, so they stay.
    window.location.hash = `#/?q=engineer&show=${PAGE_SIZE * 3}`;
    renderApp(createFixtureDashboardClient(manyApplications(PAGE_SIZE * 3)));
    await screen.findByRole('link', { name: 'Engineer 0' });

    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE);
    expect(screen.getByRole('searchbox', { name: 'Search company or role' })).toHaveValue(
      'engineer',
    );
    // Rewritten in place, so the dropped count is not left one Back away.
    expect(window.location.hash).toBe('#/?q=engineer');
  });

  it('collapses back to one batch when the filter changes', async () => {
    // The revealed rows belonged to a different result set; carrying the count over would show a
    // larger slice of the new one than the user ever asked for.
    const { user } = renderApp(createFixtureDashboardClient(manyApplications(PAGE_SIZE * 3)));
    await screen.findByRole('link', { name: 'Engineer 0' });

    await user.click(screen.getByRole('button', { name: `Load ${PAGE_SIZE} more` }));
    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'engineer');

    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE);
    expect(window.location.hash).toBe('#/?q=engineer');
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

    expect(within(rowFor('Senior Frontend Engineer')).getByText('Brex')).toBeInTheDocument();
  });

  it('does not show a note count on the row', async () => {
    renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    // app-brex has three notes; the count belonged on the detail page, not the list.
    expect(
      within(rowFor('Senior Frontend Engineer')).queryByText(/notes?$/),
    ).not.toBeInTheDocument();
  });

  it('opens the application detail when a non-interactive part of its row is clicked', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.click(within(rowFor('Senior Frontend Engineer')).getByText('Brex'));

    expect(
      await screen.findByRole('heading', { name: 'Senior Frontend Engineer' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/applications/app-brex');
  });

  it('opens the job posting in a new tab, without going to the detail page', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    const posting = within(rowFor('Senior Frontend Engineer')).getByRole('link', {
      name: /Open the Brex job posting in a new tab/,
    });

    expect(posting).toHaveAttribute('href', 'https://boards.greenhouse.io/brex/jobs/4012');
    expect(posting).toHaveAttribute('target', '_blank');
    expect(posting).toHaveAttribute('rel', 'noreferrer');
    // It must remain an external posting link, not the row's application-detail link.
    expect(posting).not.toHaveAttribute('href', '#/applications/app-brex');
    posting.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await user.click(posting);
    expect(window.location.hash).toBe('#/');
  });

  it('changes a stage from the row without navigating away', async () => {
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Staff Engineer, Platform' });

    const select = screen.getByRole('combobox', { name: /Stage for Staff Engineer, Platform/ });
    await user.selectOptions(select, 'onsite');

    await waitFor(() => expect(select).toHaveValue('onsite'));
    // Still on the list.
    expect(screen.getByRole('searchbox', { name: 'Search company or role' })).toBeInTheDocument();
  });
});

describe('log application', () => {
  it('extracts, reviews, and adds a manual application to the shared dashboard store', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { user } = renderApp(client);
    await user.click(await screen.findByRole('button', { name: 'Log application' }));

    const dialog = screen.getByRole('dialog', { name: 'Log an application' });
    expect(dialog).toBeInTheDocument();
    expect(window.location.hash).toBe('#/');

    await user.type(
      await screen.findByRole('textbox', { name: 'Job posting URL' }),
      'https://example.com/jobs/platform-engineer',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Job description' }),
      'Platform engineer role using TypeScript and Postgres.',
    );
    await user.click(screen.getByRole('button', { name: 'Extract job details' }));

    const company = await screen.findByRole('textbox', { name: 'Company' });
    const role = screen.getByRole('textbox', { name: 'Role' });
    await user.clear(company);
    await user.type(company, 'Example Labs');
    await user.clear(role);
    await user.type(role, 'Platform Engineer');
    await user.click(within(dialog).getByRole('button', { name: 'Log application' }));

    expect(screen.queryByRole('dialog', { name: 'Log an application' })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Platform Engineer' })).toBeInTheDocument();
    expect(within(rowFor('Platform Engineer')).getByText('Example Labs')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/');
    expect((await client.listApplications())[0]).toMatchObject({
      company: 'Example Labs',
      roleTitle: 'Platform Engineer',
      source: 'manual',
    });
  });

  it('explains that a base profile is required before logging', async () => {
    const { user } = renderApp(createFixtureDashboardClient(fixtureApplications));
    await user.click(await screen.findByRole('button', { name: 'Log application' }));

    expect(await screen.findByText('A profile is required first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Extract job details' })).not.toBeInTheDocument();
  });

  it('closes the modal without navigating and returns focus to its trigger', async () => {
    const { user } = renderApp();
    const trigger = await screen.findByRole('button', { name: 'Log application' });
    await user.click(trigger);

    await user.click(screen.getByRole('button', { name: 'Close log application' }));

    expect(screen.queryByRole('dialog', { name: 'Log an application' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(window.location.hash).toBe('#/');
  });

  it('locks page scrolling and closes from Escape or the backdrop', async () => {
    const { user } = renderApp();
    const trigger = await screen.findByRole('button', { name: 'Log application' });

    await user.click(trigger);
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Log an application' })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Log an application' });
    await user.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog', { name: 'Log an application' })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps keyboard focus inside the modal', async () => {
    const { user } = renderApp(createFixtureDashboardClient(fixtureApplications, fixtureProfile));
    await user.click(await screen.findByRole('button', { name: 'Log application' }));

    const close = screen.getByRole('button', { name: 'Close log application' });
    const description = await screen.findByRole('textbox', { name: 'Job description' });
    expect(close).toHaveFocus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(description).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(close).toHaveFocus();
  });
});

describe('routing', () => {
  it('opens an application from its row link', async () => {
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

  it('groups requirement kinds once while preserving years and keyword categories', async () => {
    window.location.hash = '#/applications/app-brex';
    renderApp();

    await screen.findByRole('heading', { name: 'Senior Frontend Engineer' });
    const jobInfo = screen.getByText('Job info').closest('details') as HTMLElement;
    const required = within(jobInfo).getByRole('heading', { name: 'required', level: 4 });
    const preferred = within(jobInfo).getByRole('heading', { name: 'preferred', level: 4 });

    expect(within(jobInfo).getAllByRole('heading', { level: 4 })).toHaveLength(2);
    expect(
      within(required.closest('section')!).getByText(/5\+ years building production React/),
    ).toBeInTheDocument();
    expect(
      within(required.closest('section')!).getByText(/Comfort owning a service end to end/),
    ).toBeInTheDocument();
    expect(
      within(preferred.closest('section')!).getByText(/Experience with design systems at scale/),
    ).toBeInTheDocument();
    expect(within(jobInfo).getByText(/\(5\+ yrs\)/)).toBeInTheDocument();
    expect(within(jobInfo).getByText('· Framework')).toBeInTheDocument();
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

    expect(picker).toHaveValue('onsite');
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
   * detail page shows the same pill the rows do and keeps the URL on the `title`.
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
    await waitFor(() => expect(picker).toHaveValue('onsite'));
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
    await user.selectOptions(sonar, 'onsite');

    // A pending write for one application does not block another application's queue.
    expect(calls).toEqual(['app-brex', 'app-sonar']);
    await waitFor(() => expect(sonar).toHaveValue('onsite'));

    brexWrite.reject(new Error('nope'));
    // The failing write reverts its own record...
    await waitFor(() => expect(brex).toHaveValue('onsite'));
    // ...and leaves the one that succeeded alone.
    expect(sonar).toHaveValue('onsite');
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
      extractJob: () => Promise.reject(new Error('unused')),
      createApplication: () => Promise.reject(new Error('unused')),
      findApplicationDuplicates: () => Promise.reject(new Error('unused')),
      updateStage: () => Promise.reject(new Error('unused')),
      addNote: () => Promise.reject(new Error('unused')),
      getProfile: () => Promise.reject(new Error('unused')),
      signIn: () => Promise.reject(new Error('unused')),
      signOut: () => Promise.reject(new Error('unused')),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('backend is not running');
  });
});

describe('auth', () => {
  /** `createFixtureDashboardClient` started signed out, so `App` sees the same 401 a real session-less request would. */
  function signedOutClient() {
    return createFixtureDashboardClient(fixtureApplications, null, { signedIn: false });
  }

  it('redirects to #/login on a 401 rather than showing a generic load error', async () => {
    renderApp(signedOutClient());

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login?from=%23%2F');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves the page it redirected from as ?from=, for App to return to after sign-in', async () => {
    window.location.hash = '#/applications/app-brex';

    renderApp(signedOutClient());

    await waitFor(() =>
      expect(window.location.hash).toBe('#/login?from=%23%2Fapplications%2Fapp-brex'),
    );
  });

  it('signs in and loads the applications list, defaulting to # when there was no from target', async () => {
    window.location.hash = '#/login';
    const { user } = renderApp(signedOutClient());
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.type(screen.getByLabelText('Email'), 'jane@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(await screen.findByText(fixtureApplications[0].roleTitle)).toBeInTheDocument();
  });

  it('reports a bad password without leaving the login page', async () => {
    const { user } = renderApp(signedOutClient());
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.type(screen.getByLabelText('Email'), 'jane@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(window.location.hash).toBe('#/login?from=%23%2F');
  });
});

describe('analytics', () => {
  // `fixtures.ts` is left alone (its `createdAt` values are absolute and already months stale), so
  // this is the one test file that fakes the clock — `rangeStart` taking `today` as a parameter is
  // what keeps everything else clock-free. Noon UTC keeps the local calendar date the same day
  // across the timezones this suite is likely to run under.
  beforeEach(() => {
    window.location.hash = '#/analytics';
    vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is reachable from the nav and marks itself current', async () => {
    window.location.hash = '#/';
    const { user } = renderApp();

    await user.click(await screen.findByRole('link', { name: 'Analytics' }));

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Applications' })).not.toHaveAttribute('aria-current');
  });

  it('shows a keyword frequency table over the default 7-day range', async () => {
    const { user } = renderApp();
    await lowerAnalyticsMinimumToOne(user);

    // React is asked for by Anthropic, Brex and Linear within seven days of the fixed clock.
    const reactRow = await screen.findByRole('button', { name: /React/ });
    expect(within(reactRow).getByText('3')).toBeInTheDocument();
  });

  it('groups the keyword table into category sections', async () => {
    const { user } = renderApp();
    await lowerAnalyticsMinimumToOne(user);

    await screen.findByRole('button', { name: /React/ });
    expect(screen.getByText('Frameworks')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
  });

  it('narrows the keyword table to terms that appeared at least N times', async () => {
    const { user } = renderApp();
    await lowerAnalyticsMinimumToOne(user);
    await screen.findByRole('button', { name: /GraphQL/ });

    const increase = screen.getByRole('button', { name: 'Increase minimum appearances' });
    await user.click(increase);

    // React (3) and TypeScript (2) cleared the bar; GraphQL and Next.js (1 each) did not.
    expect(screen.getByRole('button', { name: /React/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /TypeScript/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GraphQL/ })).not.toBeInTheDocument();
  });

  it('cannot decrease the minimum below 1, and shows the current value', async () => {
    const { user } = renderApp();

    const stepper = await screen.findByRole('group', { name: 'Min. appearances' });
    const decrease = within(stepper).getByRole('button', { name: 'Decrease minimum appearances' });
    expect(within(stepper).getByText('5')).toBeInTheDocument();
    expect(decrease).not.toBeDisabled();

    for (let value = 5; value > 1; value--) await user.click(decrease);
    expect(decrease).toBeDisabled();

    const increase = within(stepper).getByRole('button', { name: 'Increase minimum appearances' });
    await user.click(increase);
    await user.click(increase);
    expect(within(stepper).getByText('3')).toBeInTheDocument();

    await user.click(decrease);
    expect(within(stepper).getByText('2')).toBeInTheDocument();
  });

  it('explains an empty keyword table caused by the appearance filter', async () => {
    renderApp();

    expect(await screen.findByText('No keywords match these filters')).toBeInTheDocument();
    // The range/stage controls stay usable — the same rule every other empty state here follows.
    expect(
      screen.getByRole('button', { name: 'Increase minimum appearances' }),
    ).toBeInTheDocument();
  });

  it('shows a summary strip over the filtered range', async () => {
    const { container } = renderApp();

    await screen.findByRole('group', { name: 'Min. appearances' });
    // Anthropic, Linear and Brex fall within the default seven-day range.
    const summary = container.querySelector('.analytics-summary');
    expect(summary).toHaveTextContent('3 postings');
  });

  it('highlights the selected keyword inside each requirement’s text', async () => {
    const { user } = renderApp();
    await lowerAnalyticsMinimumToOne(user);
    const reactRow = await screen.findByRole('button', { name: /^React/ });

    await user.click(reactRow);

    // Both Anthropic's and Brex's first requirement mention "React" in the sentence itself.
    const marks = await screen.findAllByText('React', { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
  });

  it('groups each posting under one Required and one Preferred heading', async () => {
    renderApp();

    const link = await screen.findByRole('link', {
      name: /Brex — Senior Frontend Engineer/,
    });
    const posting = link.closest('article') as HTMLElement;
    const required = within(posting).getByRole('heading', { name: 'required', level: 3 });
    const preferred = within(posting).getByRole('heading', { name: 'preferred', level: 3 });

    expect(within(posting).getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(
      within(required.closest('section')!).getByText(/5\+ years building production React/),
    ).toBeInTheDocument();
    // Unclassified requirements stay visible under Required instead of creating a third heading.
    expect(
      within(required.closest('section')!).getByText(/Comfort owning a service end to end/),
    ).toBeInTheDocument();
    expect(
      within(preferred.closest('section')!).getByText(/Experience with design systems at scale/),
    ).toBeInTheDocument();
  });

  it('narrows the range and drops postings outside it', async () => {
    window.location.hash = '#/analytics?range=30d';
    const { user } = renderApp();
    await lowerAnalyticsMinimumToOne(user);
    await screen.findByRole('button', { name: /React/ });

    await user.click(screen.getByRole('button', { name: '7 days' }));

    // Only Anthropic (3/19), Linear (3/16) and Brex (3/14) fall within 7 days of 3/20.
    const reactRow = await screen.findByRole('button', { name: /React/ });
    expect(within(reactRow).getByText('3')).toBeInTheDocument();
  });

  it('filters by stage using the same pills the applications list uses', async () => {
    const { user } = renderApp();
    await lowerAnalyticsMinimumToOne(user);
    await screen.findByRole('button', { name: /React/ });

    await user.click(screen.getByRole('button', { name: /^Onsite/ }));

    // Brex is the only onsite-stage posting inside the default 7-day range — Stripe is also
    // onsite but its createdAt falls outside it.
    expect(screen.getByRole('button', { name: /GraphQL/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next\.js/ })).not.toBeInTheDocument();
  });

  it('counts a stage pill against the selected range, not against every application ever saved', async () => {
    renderApp();
    await screen.findByRole('group', { name: 'Min. appearances' });

    // Two applications are onsite-stage (Brex and the legacy Stripe row), but Stripe's
    // createdAt falls outside the default 7-day range — the pill must count only Brex.
    expect(screen.getByRole('button', { name: /^Onsite/ })).toHaveAccessibleName('Onsite1');
  });

  it('shows a notice instead of coverage badges when no Profile is saved', async () => {
    renderApp(createFixtureDashboardClient(fixtureApplications));

    expect(await screen.findByText(/No profile saved yet/)).toBeInTheDocument();
  });

  it('shows a failure notice when the Profile cannot be reached', async () => {
    renderApp({
      ...createFixtureDashboardClient(fixtureApplications),
      getProfile: () => Promise.reject(new Error('backend is not running')),
    });

    expect(await screen.findByText(/Couldn.t load your profile/)).toBeInTheDocument();
    expect(screen.getByText(/backend is not running/)).toBeInTheDocument();
  });

  it('clears cached applications and redirects to sign-in when loading the Profile returns 401', async () => {
    renderApp({
      ...createFixtureDashboardClient(fixtureApplications),
      getProfile: () =>
        Promise.reject(new HttpError('http', '/profile', 'Authentication required', 401)),
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login?from=%23%2Fanalytics');
    expect(screen.queryByText(/Couldn.t load your profile/)).not.toBeInTheDocument();
    expect(screen.queryByText('Brex')).not.toBeInTheDocument();
  });

  it('shows coverage badges and narrows Gaps only to what the Profile does not evidence', async () => {
    const { user } = renderApp(createFixtureDashboardClient(fixtureApplications, fixtureProfile));
    await lowerAnalyticsMinimumToOne(user);

    // React is in fixtureProfile's skills — covered. Next.js is not, and evidences nowhere else.
    const reactRow = await screen.findByRole('button', { name: /React/ });
    expect(within(reactRow).getByText('In skills')).toBeInTheDocument();
    const nextJsRow = screen.getByRole('button', { name: /Next\.js/ });
    expect(within(nextJsRow).getByText('Gap')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Gaps only' }));

    expect(screen.queryByRole('button', { name: /^React / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next\.js/ })).toBeInTheDocument();
  });

  it('narrows the requirements panel to postings that asked for a selected keyword', async () => {
    window.location.hash = '#/analytics?range=30d';
    const { user } = renderApp();
    await lowerAnalyticsMinimumToOne(user);
    const nextJsRow = await screen.findByRole('button', { name: /Next\.js/ });

    await user.click(nextJsRow);

    // Next.js is asked for by Anthropic and Vercel; Brex is not.
    expect(
      await screen.findByRole('link', { name: /Anthropic — Member of Technical Staff, Product/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Vercel — Software Engineer, Developer Experience/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Brex — Senior Frontend Engineer/ }),
    ).not.toBeInTheDocument();
  });

  it('presents requested experience as readable thresholds', async () => {
    const applications = structuredClone(fixtureApplications.slice(0, 2));
    applications[0].jobInfo.requirements[0].yearsOfExperience = 1;
    applications[1].jobInfo.requirements[1].yearsOfExperience = 5;
    const { user, container } = renderApp(createFixtureDashboardClient(applications));

    await screen.findByRole('group', { name: 'Min. appearances' });
    const summary = container.querySelector('.analytics-summary-strip') as HTMLElement;
    const toggle = within(summary).getByRole('button', { name: /^Experience requested/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(summary).toHaveTextContent('2 thresholds');
    expect(summary.querySelectorAll('.analytics-summary-strip__year')).toHaveLength(0);

    await user.click(toggle);

    const thresholds = summary.querySelectorAll('.analytics-summary-strip__year');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(thresholds[0]).toHaveTextContent('1+ year · 1 request');
    expect(thresholds[1]).toHaveTextContent('5+ years · 2 requests');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(summary.querySelectorAll('.analytics-summary-strip__year')).toHaveLength(0);
  });

  it('scopes the requirements summary to postings matching the selected keyword', async () => {
    window.location.hash = '#/analytics?range=30d';
    const { user, container } = renderApp();
    await lowerAnalyticsMinimumToOne(user);

    await user.click(await screen.findByRole('button', { name: /Next\.js/ }));

    const summary = container.querySelector('.analytics-summary-strip');
    expect(summary).not.toHaveTextContent('Experience requested');
    expect(summary).not.toHaveTextContent('5+ years');
  });

  it('returns to Analytics with its filters intact from a posting opened in the requirements panel', async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole('button', { name: '30 days' }));
    const link = await screen.findByRole('link', {
      name: /Anthropic — Member of Technical Staff, Product/,
    });

    await user.click(link);

    const back = await screen.findByRole('link', { name: '← Analytics' });
    expect(back).toHaveAttribute('href', '#/analytics?range=30d');
  });

  it('keeps the range and stage controls visible when nothing is in range', async () => {
    const { user } = renderApp();
    await screen.findByRole('group', { name: 'Min. appearances' });
    // Ramp (3/8) is the only phone_screen-stage posting, and it falls outside 7 days of 3/20.
    await user.click(screen.getByRole('button', { name: /^Phone screen/ }));

    expect(
      await screen.findByText(/Widen the range or change the stage filter/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Phone screen/ })).toBeInTheDocument();
  });

  it('shows the empty state with no applications at all', async () => {
    renderApp(createFixtureDashboardClient([]));

    expect(
      await screen.findByText(/No applications yet\. Fill one in with the extension/),
    ).toBeInTheDocument();
  });
});
