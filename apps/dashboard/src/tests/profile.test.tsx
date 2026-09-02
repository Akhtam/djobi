/**
 * The account menu (Profile / Sign out) and the `#/profile` editor it opens.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureDashboardClient } from '../lib/dashboardClient';
import { fixtureApplications, fixtureProfile } from '../lib/fixtures';
import { renderDashboard } from './test-utils';

describe('account menu', () => {
  it('opens Profile from the account menu and edits and saves the profile', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { user } = renderDashboard({ client });

    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    // The avatar's letter comes from the Profile's name, fetched once on mount.
    expect(await screen.findByText(fixtureProfile.fullName[0].toUpperCase())).toBeInTheDocument();

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Profile' }));

    expect(await screen.findByRole('heading', { name: 'Your profile' })).toBeInTheDocument();
    const nameField = await screen.findByLabelText('Full name');
    expect(nameField).toHaveValue(fixtureProfile.fullName);

    await user.clear(nameField);
    await user.type(nameField, 'Jane Updated');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(await client.getProfile()).toMatchObject({ fullName: 'Jane Updated' });
  });

  it('signs out from the account menu and redirects to login', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { user } = renderDashboard({ client });

    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
