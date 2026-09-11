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
  it.each([
    ['#/login', 'Sign in'],
    ['#/signup', 'Create an account'],
  ] as const)('uses the public header on %s', async (hash, heading) => {
    renderDashboard({ client: signedOutClient(), hash });
    await screen.findByRole('heading', { name: heading });

    expect(screen.getByRole('link', { name: 'djobi home' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('navigation', { name: 'Views' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Applications' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Analytics' })).not.toBeInTheDocument();
  });

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

  it('links from #/login to #/signup and back', async () => {
    const { user } = renderDashboard({ client: signedOutClient(), hash: '#/login' });
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.click(screen.getByRole('link', { name: 'Create one' }));
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('creates an account and lands signed in on the applications list', async () => {
    const { user } = renderDashboard({ client: signedOutClient(), hash: '#/signup' });
    await screen.findByRole('heading', { name: 'Create an account' });

    await user.type(screen.getByLabelText('Name'), 'Jane Doe');
    await user.type(screen.getByLabelText('Email'), 'newperson@example.com');
    await user.type(screen.getByLabelText('Password'), 'a robust new password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(await screen.findByText(fixtureApplications[0].roleTitle)).toBeInTheDocument();
  });

  it('rejects a too-short password before submitting', async () => {
    const { user } = renderDashboard({ client: signedOutClient(), hash: '#/signup' });
    await screen.findByRole('heading', { name: 'Create an account' });

    await user.type(screen.getByLabelText('Name'), 'Jane Doe');
    await user.type(screen.getByLabelText('Email'), 'newperson@example.com');
    await user.type(screen.getByLabelText('Password'), 'short1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/signup');
  });
});
