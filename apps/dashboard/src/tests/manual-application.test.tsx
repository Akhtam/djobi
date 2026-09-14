/** Logging an application by hand: the modal's extract → review → save flow, and its own focus/scroll behavior. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobInfo } from '@djobi/shared';
import { createFixtureDashboardClient, type DashboardClient } from '../lib/dashboardClient';
import { fixtureApplications, fixtureProfile } from '../lib/fixtures';
import { deferred, renderDashboard, rowFor } from './test-utils';

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

  it('reports a failed save in the modal instead of leaving the candidate with no feedback', async () => {
    const base = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const client: DashboardClient = {
      ...base,
      createApplication: () => Promise.reject(new Error('backend unreachable')),
    };
    const { user } = renderDashboard({ client });
    await user.click(await screen.findByRole('button', { name: 'Log application' }));

    await user.type(
      await screen.findByRole('textbox', { name: 'Job posting URL' }),
      'https://example.com/jobs/platform-engineer',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Job description' }),
      'Platform engineer role using TypeScript and Postgres.',
    );
    await user.click(screen.getByRole('button', { name: 'Extract job details' }));

    const dialog = await screen.findByRole('dialog', { name: 'Log an application' });
    await user.click(within(dialog).getByRole('button', { name: 'Log application' }));

    // Scoped to the modal: the store's own list-level banner reports the same failure a second
    // way (`writeError`), which is exactly why this in-modal message matters — that outer banner
    // sits above a modal the candidate's focus is still inside.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Couldn’t log this application. Something went wrong logging the application.',
    );
    // Stays open and reviewable — a failed save must not look like a closed, successful one.
    expect(screen.getByRole('dialog', { name: 'Log an application' })).toBeInTheDocument();
    expect(await client.listApplications()).toHaveLength(fixtureApplications.length);
  });

  it('disables the source fields while extraction is in flight, and saves what was actually analyzed even if they change anyway', async () => {
    const extraction = deferred<JobInfo>();
    const base = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const client: DashboardClient = { ...base, extractJob: () => extraction.promise };
    const { user } = renderDashboard({ client });
    await user.click(await screen.findByRole('button', { name: 'Log application' }));

    const urlField = await screen.findByRole('textbox', { name: 'Job posting URL' });
    const descriptionField = screen.getByRole('textbox', { name: 'Job description' });
    await user.type(urlField, 'https://example.com/jobs/original');
    await user.type(descriptionField, 'Original description, sent to the model.');
    await user.click(screen.getByRole('button', { name: 'Extract job details' }));

    expect(urlField).toBeDisabled();
    expect(descriptionField).toBeDisabled();

    // A disabled input refuses keystrokes, but nothing stops its value from being set some other
    // way — a browser extension, a paste event that lands before the DOM reflects `disabled`, or
    // simply a re-render race. `fireEvent.change` reproduces that: the point of the snapshot in
    // `NewApplication.tsx`'s `handleExtract` is that it must not matter either way.
    fireEvent.change(urlField, {
      target: { value: 'https://example.com/jobs/edited-mid-flight' },
    });
    fireEvent.change(descriptionField, {
      target: { value: 'Edited after the request had already been sent.' },
    });

    extraction.resolve({
      company: 'Example Labs',
      team: null,
      roleTitle: 'Platform Engineer',
      seniority: null,
      location: null,
      requirements: [],
      keywords: [],
    });

    const dialog = await screen.findByRole('dialog', { name: 'Log an application' });
    await user.click(await within(dialog).findByRole('button', { name: 'Log application' }));

    expect(screen.queryByRole('dialog', { name: 'Log an application' })).not.toBeInTheDocument();
    expect((await client.listApplications())[0]).toMatchObject({
      jobUrl: 'https://example.com/jobs/original',
      rawDescription: 'Original description, sent to the model.',
    });
  });

  it('explains that a base profile is required before logging', async () => {
    const { user } = renderDashboard({ client: createFixtureDashboardClient(fixtureApplications) });
    await user.click(await screen.findByRole('button', { name: 'Log application' }));

    expect(await screen.findByText('You need a profile first')).toBeInTheDocument();
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
