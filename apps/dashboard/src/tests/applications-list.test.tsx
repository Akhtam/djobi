/**
 * The applications list: what it shows, how it filters and paginates, and what a row does when
 * clicked. Stage editing and manual logging get their own files — see `application-mutations` and
 * `manual-application` — this one is the read/browse surface.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureDashboardClient } from '../lib/dashboardClient';
import { PAGE_SIZE } from '../lib/useHashRoute';
import { manyApplications, renderDashboard, rowFor } from './test-utils';

describe('applications list', () => {
  it('renders a row per application once loaded', async () => {
    renderDashboard();

    expect(
      await screen.findByRole('link', { name: 'Senior Frontend Engineer' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Engineer|Product/ }).length).toBeGreaterThan(1);
  });

  it('summarises the count and how many are live', async () => {
    renderDashboard();
    expect(await screen.findByText(/8 applications · 4 in progress/)).toBeInTheDocument();
  });

  it('renders the scan-first table columns and manual-log action', async () => {
    renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual(
      ['Company', 'Posting', 'Role', 'Source', 'Status', 'Applied'],
    );
    expect(screen.getByRole('button', { name: 'Log application' })).toBeInTheDocument();
    const row = rowFor('Senior Frontend Engineer');
    expect(within(row).getByText('Job posting')).toBeInTheDocument();
    expect(within(row).getByText('Greenhouse')).toBeInTheDocument();
  });

  it('sorts by applied date in either direction', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    const heading = screen.getByRole('columnheader', { name: /Applied/ });
    expect(heading).toHaveAttribute('aria-sort', 'descending');

    await user.click(screen.getByRole('button', { name: 'Sort by applied date, oldest first' }));

    expect(heading).toHaveAttribute('aria-sort', 'ascending');
    expect(window.location.hash).toBe('#/?sort=oldest');
    expect(
      within(screen.getAllByRole('row')[1]).getByRole('link', { name: 'Frontend Engineer' }),
    ).toHaveAttribute('href', '#/applications/app-notion');

    await user.click(screen.getByRole('button', { name: 'Sort by applied date, newest first' }));
    expect(heading).toHaveAttribute('aria-sort', 'descending');
    expect(window.location.hash).toBe('#/');
  });

  it('filters by stage', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.click(screen.getByRole('button', { name: /^Rejected/ }));

    expect(
      screen.getByRole('link', { name: 'Software Engineer, Developer Experience' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Senior Frontend Engineer' }),
    ).not.toBeInTheDocument();
  });

  it('shows an icon for every stage filter', async () => {
    renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    const filters = screen.getByRole('group', { name: 'Filter by stage' });
    expect(filters.querySelectorAll('.filter-pill__icon')).toHaveLength(6);
  });

  it('shows both kinds of rejection under the one Rejected pill', async () => {
    const { user } = renderDashboard();
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

  it('filters rejected applications by ATS or non-ATS outcome', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    expect(
      screen.queryByRole('group', { name: 'Filter rejected applications' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Rejected/ }));

    const rejectionFilters = screen.getByRole('group', { name: 'Filter rejected applications' });
    expect(
      within(rejectionFilters).getByRole('button', { name: /^All rejected/ }),
    ).toHaveAccessibleName('All rejected2');
    expect(within(rejectionFilters).getByRole('button', { name: /^ATS/ })).toHaveAccessibleName(
      'ATS1',
    );
    expect(within(rejectionFilters).getByRole('button', { name: /^Non-ATS/ })).toHaveAccessibleName(
      'Non-ATS1',
    );

    await user.click(within(rejectionFilters).getByRole('button', { name: /^ATS/ }));
    expect(
      screen.getByRole('link', { name: 'Member of Technical Staff, Product' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Software Engineer, Developer Experience' }),
    ).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/?stage=rejected&rejection=rejected_ats');

    await user.click(within(rejectionFilters).getByRole('button', { name: /^Non-ATS/ }));
    expect(
      screen.queryByRole('link', { name: 'Member of Technical Staff, Product' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Software Engineer, Developer Experience' }),
    ).toBeInTheDocument();
  });

  it('clears the rejection outcome when another stage is selected', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.click(screen.getByRole('button', { name: /^Rejected/ }));
    const rejectionFilters = screen.getByRole('group', { name: 'Filter rejected applications' });
    await user.click(within(rejectionFilters).getByRole('button', { name: /^ATS/ }));
    await user.click(screen.getByRole('button', { name: /^Applied/ }));

    expect(window.location.hash).toBe('#/?stage=applied');
    expect(
      screen.queryByRole('group', { name: 'Filter rejected applications' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Rejected/ }));
    expect(
      within(screen.getByRole('group', { name: 'Filter rejected applications' })).getByRole(
        'button',
        { name: /^All rejected/ },
      ),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('counts both rejections on the one pill', async () => {
    renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    // One `rejected` fixture and one `rejected_ats`; the subtype controls stay hidden until needed.
    expect(screen.getByRole('button', { name: /^Rejected/ })).toHaveAccessibleName('Rejected2');
    expect(screen.queryByRole('button', { name: /ATS/ })).not.toBeInTheDocument();
  });

  it('filters by a search over company and role', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'ramp');

    expect(screen.getByRole('link', { name: 'Product Engineer' })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Senior Frontend Engineer' }),
    ).not.toBeInTheDocument();
  });

  it('counts each stage within the company or role search', async () => {
    const { user } = renderDashboard();
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
    const { user } = renderDashboard();
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
    renderDashboard({ hash: '#/?q=ramp&stage=phone_screen' });

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
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });
    const before = window.history.length;

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'ramp');

    expect(window.location.hash).toBe('#/?q=ramp');
    expect(window.history.length).toBe(before);
  });

  it('reveals only the first batch, and offers the rest', async () => {
    renderDashboard({ client: createFixtureDashboardClient(manyApplications(PAGE_SIZE + 5)) });
    await screen.findByRole('link', { name: 'Engineer 0' });

    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE);
    expect(screen.queryByRole('link', { name: `Engineer ${PAGE_SIZE}` })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(
      screen.getByText(`Showing ${PAGE_SIZE} of ${PAGE_SIZE + 5} applications`),
    ).toBeInTheDocument();
  });

  it('keeps what is already on screen when more is loaded', async () => {
    const { user } = renderDashboard({
      client: createFixtureDashboardClient(manyApplications(PAGE_SIZE + 5)),
    });
    await screen.findByRole('link', { name: 'Engineer 0' });

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    // The point of Load more over paging: the first batch does not go anywhere.
    expect(screen.getByRole('link', { name: 'Engineer 0' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Engineer ${PAGE_SIZE}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load/ })).not.toBeInTheDocument();
  });

  it('offers no button when everything already fits', async () => {
    renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    expect(screen.queryByRole('button', { name: /Load/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
  });

  it('keeps the revealed rows through opening an application and coming back', async () => {
    const { user } = renderDashboard({
      client: createFixtureDashboardClient(manyApplications(PAGE_SIZE * 3)),
    });
    await screen.findByRole('link', { name: 'Engineer 0' });

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await user.click(screen.getByRole('link', { name: `Engineer ${PAGE_SIZE}` }));
    await user.click(await screen.findByRole('link', { name: '← Applications' }));

    expect(await screen.findByRole('link', { name: `Engineer ${PAGE_SIZE}` })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE * 2);
  });

  it('starts a freshly loaded document at the first batch, keeping the filters', async () => {
    // `?show=` is a place in a session, not an intent: a reload should not render hundreds of rows
    // nobody has asked for again. The filters are an intent, so they stay.
    renderDashboard({
      hash: `#/?q=engineer&show=${PAGE_SIZE * 3}`,
      client: createFixtureDashboardClient(manyApplications(PAGE_SIZE * 3)),
    });
    await screen.findByRole('link', { name: 'Engineer 0' });

    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE);
    expect(screen.getByRole('searchbox', { name: 'Search company or role' })).toHaveValue(
      'engineer',
    );
    // Rewritten in place, so the dropped count is not left one Back away.
    expect(window.location.hash).toBe('#/?q=engineer');
  });

  // Sorting reorders the same rows; it does not narrow which ones qualify, so `Load more`'d rows
  // must survive it — unlike an actual filter change, which does collapse `shown` (see the test
  // below).
  it('keeps the revealed rows through a re-sort', async () => {
    const { user } = renderDashboard({
      client: createFixtureDashboardClient(manyApplications(PAGE_SIZE + 5)),
    });
    await screen.findByRole('link', { name: 'Engineer 0' });

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByRole('link', { name: `Engineer ${PAGE_SIZE}` })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sort by applied date, oldest first' }));

    expect(screen.getByRole('link', { name: 'Engineer 0' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Engineer ${PAGE_SIZE}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load/ })).not.toBeInTheDocument();
  });

  it('collapses back to one batch when the filter changes', async () => {
    // The revealed rows belonged to a different result set; carrying the count over would show a
    // larger slice of the new one than the user ever asked for.
    const { user } = renderDashboard({
      client: createFixtureDashboardClient(manyApplications(PAGE_SIZE * 3)),
    });
    await screen.findByRole('link', { name: 'Engineer 0' });

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'engineer');

    expect(screen.getAllByRole('link', { name: /^Engineer/ })).toHaveLength(PAGE_SIZE);
    expect(window.location.hash).toBe('#/?q=engineer');
  });

  it('says a filter matched nothing rather than looking like data loss', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.type(screen.getByRole('searchbox', { name: 'Search company or role' }), 'zzzz');

    expect(screen.getByText('No applications match that filter.')).toBeInTheDocument();
  });

  it('distinguishes an empty dataset from an over-narrow filter', async () => {
    renderDashboard({ client: createFixtureDashboardClient([]) });
    expect(await screen.findByText(/No applications yet/)).toBeInTheDocument();
  });

  it('leads with the company, not the role', async () => {
    renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    expect(within(rowFor('Senior Frontend Engineer')).getByText('Brex')).toBeInTheDocument();
  });

  it('does not show a note count on the row', async () => {
    renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    // app-brex has three notes; the count belonged on the detail page, not the list.
    expect(
      within(rowFor('Senior Frontend Engineer')).queryByText(/notes?$/),
    ).not.toBeInTheDocument();
  });

  it('opens the application detail when a non-interactive part of its row is clicked', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    await user.click(within(rowFor('Senior Frontend Engineer')).getByText('Brex'));

    expect(
      await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/applications/app-brex');
  });

  it('opens the job posting in a new tab, without going to the detail page', async () => {
    const { user } = renderDashboard();
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
    const { user } = renderDashboard();
    await screen.findByRole('link', { name: 'Staff Engineer, Platform' });

    const select = screen.getByRole('combobox', { name: /Stage for Staff Engineer, Platform/ });
    await user.selectOptions(select, 'onsite');

    await waitFor(() => expect(select).toHaveValue('onsite'));
    // Still on the list.
    expect(screen.getByRole('searchbox', { name: 'Search company or role' })).toBeInTheDocument();
  });
});
