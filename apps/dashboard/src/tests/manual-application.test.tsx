/** Logging an application by hand: the modal's extract → review → save flow, and its own focus/scroll behavior. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureDashboardClient } from '../lib/dashboardClient';
import { fixtureApplications, fixtureProfile } from '../lib/fixtures';
import { renderDashboard, rowFor } from './test-utils';

describe('log application', () => {
  it('extracts, reviews, and adds a manual application to the shared dashboard store', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { user } = renderDashboard({ client });
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
    const { user } = renderDashboard({ client: createFixtureDashboardClient(fixtureApplications) });
    await user.click(await screen.findByRole('button', { name: 'Log application' }));

    expect(await screen.findByText('A profile is required first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Extract job details' })).not.toBeInTheDocument();
  });

  it('closes the modal without navigating and returns focus to its trigger', async () => {
    const { user } = renderDashboard();
    const trigger = await screen.findByRole('button', { name: 'Log application' });
    await user.click(trigger);

    await user.click(screen.getByRole('button', { name: 'Close log application' }));

    expect(screen.queryByRole('dialog', { name: 'Log an application' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(window.location.hash).toBe('#/');
  });

  it('locks page scrolling and closes from Escape or the backdrop', async () => {
    const { user } = renderDashboard();
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
    const { user } = renderDashboard({
      client: createFixtureDashboardClient(fixtureApplications, fixtureProfile),
    });
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
