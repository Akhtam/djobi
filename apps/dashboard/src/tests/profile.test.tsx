/**
 * The account menu (Profile / Sign out) and the `#/profile` editor it opens.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureDashboardClient } from '../lib/dashboardClient';
import { fixtureApplications, fixtureExtractedProfile, fixtureProfile } from '../lib/fixtures';
import { renderDashboard } from './test-utils';

describe('account menu', () => {
  it('opens Profile from the account menu and edits and saves the profile', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { user } = renderDashboard({ client });

    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    // The avatar's letter comes from the Profile's name, fetched once on mount.
    expect(await screen.findByText(fixtureProfile.fullName[0]!.toUpperCase())).toBeInTheDocument();

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

  it('uploads a resume, pre-fills the reviewable form from the extraction, and saves the reviewed result', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { user } = renderDashboard({ client, hash: '#/profile' });

    await screen.findByLabelText('Full name');
    const file = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Resume PDF'), file);

    await screen.findByText('Resume parsed. Review the pre-filled fields below, then save.');

    // Fields the extraction found are pre-filled, in the same inputs as any manual edit —
    expect(screen.getByLabelText('Full name')).toHaveValue(fixtureExtractedProfile.fullName);
    expect(screen.getByLabelText('Summary')).toHaveValue(fixtureExtractedProfile.summary);
    // — but a field the extraction found nothing for keeps what the fixture Profile already had
    // (`fixtureProfile.location` is 'Remote'; the extraction also says 'Remote', so assert on a
    // field that genuinely differs instead: the fixture Profile has no projects, the extraction does).
    expect(screen.getByLabelText('Name 1')).toHaveValue('djobi');
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();

    // The candidate reviews and corrects the pre-filled draft before saving, like any other edit.
    const summaryField = screen.getByLabelText('Summary');
    await user.clear(summaryField);
    await user.type(summaryField, 'Senior backend engineer.');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    const saved = await client.getProfile();
    expect(saved?.fullName).toBe(fixtureExtractedProfile.fullName);
    expect(saved?.summary).toBe('Senior backend engineer.');
    expect(saved?.projects).toEqual(fixtureExtractedProfile.projects);
  });

  it('reports a clear error and leaves the form untouched, falling back to manual entry', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile, undefined, {
      error: 'No extractable text was found in this PDF.',
    });
    const { user } = renderDashboard({ client, hash: '#/profile' });

    await screen.findByLabelText('Full name');
    const file = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Resume PDF'), file);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't parse this resume: No extractable text was found in this PDF.",
    );
    expect(screen.getByLabelText('Full name')).toHaveValue(fixtureProfile.fullName);
    expect(screen.queryByText('You have unsaved changes.')).not.toBeInTheDocument();
  });

  it('redirects to login when the upload itself hits a 401, same as any other route', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { user } = renderDashboard({ client, hash: '#/profile' });
    await screen.findByLabelText('Full name');
    await client.signOut();

    const file = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Resume PDF'), file);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('adds a certification-or-award row, defaults it to a certification, and saves it', async () => {
    const loaded = { ...fixtureProfile, certifications: [], awards: [] };
    const client = createFixtureDashboardClient(fixtureApplications, loaded);
    const { user } = renderDashboard({ client, hash: '#/profile' });

    await screen.findByLabelText('Full name');
    await user.click(screen.getByRole('button', { name: 'Add certification or award' }));

    expect(screen.getByLabelText('Type 1')).toHaveValue('certification');
    expect(screen.queryByLabelText('Description 1')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Name 1'), 'AWS Certified');
    await user.type(screen.getByLabelText('Issuer 1'), 'Amazon');
    await user.type(screen.getByLabelText('Date 1'), '2024');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    const saved = await client.getProfile();
    expect(saved?.certifications).toEqual([
      { name: 'AWS Certified', issuer: 'Amazon', date: '2024' },
    ]);
    expect(saved?.awards).toEqual([]);
  });

  it('switches a row to Award, exposing the description field, and saves it under awards', async () => {
    const loaded = {
      ...fixtureProfile,
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2024' }],
      awards: [],
    };
    const client = createFixtureDashboardClient(fixtureApplications, loaded);
    const { user } = renderDashboard({ client, hash: '#/profile' });

    await screen.findByLabelText('Full name');
    await user.selectOptions(screen.getByLabelText('Type 1'), 'award');

    expect(screen.getByLabelText('Name 1')).toHaveValue('AWS Certified');
    await user.type(screen.getByLabelText('Description 1'), 'Top of the cohort');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    const saved = await client.getProfile();
    expect(saved?.certifications).toEqual([]);
    expect(saved?.awards).toEqual([
      { name: 'AWS Certified', issuer: 'Amazon', date: '2024', description: 'Top of the cohort' },
    ]);
  });

  it('shows existing certifications and awards together, each tagged with its own type', async () => {
    const loaded = {
      ...fixtureProfile,
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2024' }],
      awards: [{ name: 'Hack Day', issuer: 'Acme', date: '2020', description: 'Won first place' }],
    };
    const client = createFixtureDashboardClient(fixtureApplications, loaded);
    renderDashboard({ client, hash: '#/profile' });

    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Type 1')).toHaveValue('certification');
    expect(screen.getByLabelText('Name 1')).toHaveValue('AWS Certified');
    expect(screen.getByLabelText('Type 2')).toHaveValue('award');
    expect(screen.getByLabelText('Name 2')).toHaveValue('Hack Day');
    expect(screen.getByLabelText('Description 2')).toHaveValue('Won first place');
  });

  it('removes a certification-or-award row', async () => {
    const loaded = {
      ...fixtureProfile,
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2024' }],
      awards: [],
    };
    const client = createFixtureDashboardClient(fixtureApplications, loaded);
    const { user } = renderDashboard({ client, hash: '#/profile' });

    await screen.findByLabelText('Full name');
    await user.click(screen.getByRole('button', { name: 'Remove certification or award 1' }));

    expect(screen.queryByLabelText('Name 1')).not.toBeInTheDocument();
  });
});
