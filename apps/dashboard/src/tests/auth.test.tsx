/** Signing in, being redirected to sign in, and getting back to where a 401 interrupted you. */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureDashboardClient } from '../lib/dashboardClient';
import { fixtureApplications } from '../lib/fixtures';
import { renderDashboard } from './test-utils';

/** `createFixtureDashboardClient` started signed out, so `App` sees the same 401 a real session-less request would. */
function signedOutClient() {
  return createFixtureDashboardClient(fixtureApplications, null, { signedIn: false });
}

describe('auth', () => {
  it('redirects to #/login on a 401 rather than showing a generic load error', async () => {
    renderDashboard({ client: signedOutClient() });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login?from=%23%2F');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves the page it redirected from as ?from=, for App to return to after sign-in', async () => {
    renderDashboard({ client: signedOutClient(), hash: '#/applications/app-brex' });

    await waitFor(() =>
      expect(window.location.hash).toBe('#/login?from=%23%2Fapplications%2Fapp-brex'),
    );
  });

  it('signs in and loads the applications list, defaulting to # when there was no from target', async () => {
    const { user } = renderDashboard({ client: signedOutClient(), hash: '#/login' });
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.type(screen.getByLabelText('Email'), 'jane@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(await screen.findByText(fixtureApplications[0].roleTitle)).toBeInTheDocument();
  });

  it('reports a bad password without leaving the login page', async () => {
    const { user } = renderDashboard({ client: signedOutClient() });
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.type(screen.getByLabelText('Email'), 'jane@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(window.location.hash).toBe('#/login?from=%23%2F');
  });
});
