import { describe, expect, it } from 'vitest';
import { HttpError } from '@djobi/http-client';
import { createFixtureDashboardClient } from './dashboardClient';
import { fixtureApplications, fixtureProfile } from './fixtures';

describe('createFixtureDashboardClient', () => {
  it('lists the seed applications', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    await expect(client.listApplications()).resolves.toHaveLength(fixtureApplications.length);
  });

  it('does not hand out a reference callers can mutate', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    const first = await client.listApplications();
    first[0].company = 'Mutated';

    const second = await client.listApplications();
    expect(second[0].company).not.toBe('Mutated');
  });

  it('persists a stage change for the session', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    await client.updateStage('app-sonar', 'onsite');

    const listed = await client.listApplications();
    expect(listed.find((a) => a.id === 'app-sonar')?.stage).toBe('onsite');
  });

  it('appends a note with a server-assigned id and timestamp', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    const before = (await client.listApplications()).find((a) => a.id === 'app-sonar')!;
    expect(before.notes).toHaveLength(0);

    const result = await client.addNote('app-sonar', {
      category: 'technical',
      text: 'Asked about JVM GC.',
    });

    expect(result.note.text).toBe('Asked about JVM GC.');
    expect(result.note.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(result.note.createdAt))).toBe(false);
    const updated = (await client.listApplications()).find((a) => a.id === 'app-sonar')!;
    expect(updated.notes).toEqual([result.note]);
  });

  it('leaves the seed untouched, so one test cannot leak into the next', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    await client.updateStage('app-sonar', 'rejected');

    expect(fixtureApplications.find((a) => a.id === 'app-sonar')?.stage).toBe('applied');
  });

  it('defaults getProfile to null, since most callers neither know nor care about it', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    await expect(client.getProfile()).resolves.toBeNull();
  });

  it('resolves getProfile with the profile a caller passed in', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    await expect(client.getProfile()).resolves.toEqual(fixtureProfile);
  });

  it('does not hand getProfile out as a reference callers can mutate', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const first = await client.getProfile();
    first!.fullName = 'Mutated';

    const second = await client.getProfile();
    expect(second!.fullName).not.toBe('Mutated');
  });
});

describe('createFixtureDashboardClient, auth', () => {
  it('starts signed in by default, so most tests need no login step', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    await expect(client.listApplications()).resolves.toHaveLength(fixtureApplications.length);
  });

  it('rejects every route with a 401 when started signed out, matching requireAuth', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, null, { signedIn: false });

    const error = await client.listApplications().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ kind: 'http', status: 401 });
    await expect(client.updateStage('app-sonar', 'onsite')).rejects.toBeInstanceOf(HttpError);
    await expect(
      client.addNote('app-sonar', { category: 'technical', text: 'x' }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(client.getProfile()).rejects.toBeInstanceOf(HttpError);
  });

  it('signs in with the default credentials and then serves normally', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, null, { signedIn: false });

    await client.signIn('jane@example.com', 'correct horse battery staple');

    await expect(client.listApplications()).resolves.toHaveLength(fixtureApplications.length);
  });

  it('rejects signIn with the wrong password rather than granting a session', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, null, { signedIn: false });

    await expect(client.signIn('jane@example.com', 'wrong')).rejects.toMatchObject({
      status: 401,
    });
    await expect(client.listApplications()).rejects.toBeInstanceOf(HttpError);
  });

  it('accepts credentials a caller configured in place of the defaults', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, null, {
      signedIn: false,
      email: 'sam@example.com',
      password: 'a different password',
    });

    await client.signIn('sam@example.com', 'a different password');

    await expect(client.listApplications()).resolves.toHaveLength(fixtureApplications.length);
  });

  it('signOut ends a session started signed in, so a later call is rejected', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);

    await client.signOut();

    await expect(client.listApplications()).rejects.toBeInstanceOf(HttpError);
  });
});
