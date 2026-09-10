/**
 * Getting from nowhere to a specific application: the marketing landing page, the hash router that
 * switches it for the dashboard, and opening/leaving a detail page by URL.
 */
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureDashboardClient } from '../lib/dashboardClient';
import { fixtureApplications } from '../lib/fixtures';
import { renderDashboard } from './test-utils';

describe('landing page', () => {
  it('renders at the bare homepage without loading authenticated dashboard data', () => {
    window.location.hash = '';
    const client = createFixtureDashboardClient(fixtureApplications);
    const listApplications = vi.spyOn(client, 'listApplications');

    renderDashboard({ client });

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
    const { user } = renderDashboard();
    const question = screen.getByText('Does djobi submit applications for me?');

    expect(question.closest('details')).not.toHaveAttribute('open');
    await user.click(question);

    expect(question.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/you review the page and submit/)).toBeInTheDocument();
  });

  it('switches to the dashboard on a hash-only navigation, with no document reload', async () => {
    window.location.hash = '';
    const client = createFixtureDashboardClient(fixtureApplications);
    renderDashboard({ client });
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
    renderDashboard();
    screen.getByRole('navigation', { name: 'Landing page' });

    act(() => {
      window.location.hash = '#product';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(screen.getByRole('navigation', { name: 'Landing page' })).toBeInTheDocument();
  });
});

describe('routing', () => {
  it('opens an application from its row link', async () => {
    const { user } = renderDashboard();
    await user.click(await screen.findByRole('link', { name: 'Senior Frontend Engineer' }));

    expect(
      await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
  });

  it('loads a detail page cold from a deep link', async () => {
    renderDashboard({ hash: '#/applications/app-ramp' });

    expect(
      await screen.findByRole('heading', { name: 'Ramp · Spend · New York, NY' }),
    ).toBeInTheDocument();
  });

  it('groups requirements by importance band, most decisive first, keeping years and keyword categories', async () => {
    renderDashboard({ hash: '#/applications/app-brex' });

    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    const jobInfo = screen.getByRole('tab', { name: 'Job info' }).closest('article') as HTMLElement;
    const headings = within(jobInfo).getAllByRole('heading', { level: 4 });

    expect(headings.map((heading) => heading.textContent)).toEqual([
      'critical',
      'high',
      'meaningful',
      'preferred',
    ]);

    const critical = within(jobInfo).getByRole('heading', { name: 'critical', level: 4 });
    const preferred = within(jobInfo).getByRole('heading', { name: 'preferred', level: 4 });

    expect(
      within(critical.closest('section')!).getByText(/5\+ years building production React/),
    ).toBeInTheDocument();
    expect(
      within(preferred.closest('section')!).getByText(/Experience with design systems at scale/),
    ).toBeInTheDocument();
    expect(within(jobInfo).getByText(/\(5\+ yrs\)/)).toBeInTheDocument();
    expect(within(jobInfo).getByText('· Framework')).toBeInTheDocument();
  });

  it('renders a posting whose requirements predate importance under one unassessed heading', async () => {
    renderDashboard({ hash: '#/applications/app-ramp' });

    await screen.findByRole('heading', { name: 'Ramp · Spend · New York, NY' });
    const jobInfo = screen.getByRole('tab', { name: 'Job info' }).closest('article') as HTMLElement;
    const headings = within(jobInfo).getAllByRole('heading', { level: 4 });

    expect(headings.map((heading) => heading.textContent)).toEqual(['not assessed']);
  });

  it('shows the same brand header on both routes', async () => {
    renderDashboard();
    expect(
      await screen.findByRole('link', { name: 'djobi — all applications' }),
    ).toBeInTheDocument();

    window.location.hash = '#/applications/app-ramp';
    await screen.findByRole('heading', { name: 'Ramp · Spend · New York, NY' });

    expect(screen.getByRole('link', { name: 'djobi — all applications' })).toBeInTheDocument();
  });

  it('puts the back link inside the detail view, above the role title', async () => {
    renderDashboard({ hash: '#/applications/app-ramp' });

    const heading = await screen.findByRole('heading', { name: 'Ramp · Spend · New York, NY' });
    const back = screen.getByRole('link', { name: '← Applications' });

    // Not in the page header: it belongs to the record, not the chrome.
    expect(back.closest('header.page-header')).toBeNull();
    expect(back.closest('article.detail')).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING === 4: the heading comes after the link.
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('goes back to the list', async () => {
    const { user } = renderDashboard({ hash: '#/applications/app-ramp' });
    await screen.findByRole('heading', { name: 'Ramp · Spend · New York, NY' });

    await user.click(screen.getByRole('link', { name: '← Applications' }));

    expect(await screen.findByRole('heading', { name: 'Applications' })).toBeInTheDocument();
  });

  it('reports an id that does not exist instead of rendering a blank page', async () => {
    renderDashboard({ hash: '#/applications/does-not-exist' });

    expect(await screen.findByText(/No application with that id/)).toBeInTheDocument();
  });
});
