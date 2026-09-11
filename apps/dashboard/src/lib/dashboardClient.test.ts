import type { ExtractedProfile } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { HttpError } from '@djobi/http-client';
import { createFixtureDashboardClient } from './dashboardClient';
import { fixtureApplications, fixtureExtractedProfile, fixtureProfile } from './fixtures';

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

  it('removes the note it is asked to remove, and only that one', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    const kept = await client.addNote('app-sonar', { category: 'general', text: 'Kept.' });
    const doomed = await client.addNote('app-sonar', { category: 'general', text: 'Mistyped.' });

    const result = await client.deleteNote('app-sonar', doomed.note.id);

    expect(result).toEqual({ id: 'app-sonar', noteId: doomed.note.id });
    const updated = (await client.listApplications()).find((a) => a.id === 'app-sonar')!;
    expect(updated.notes).toEqual([kept.note]);
  });

  it('rejects a delete of a note that is not there, the way the route 404s', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);

    await expect(client.deleteNote('app-sonar', 'no-such-note')).rejects.toThrow();
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

  it('creates a full application row and includes it in later lists', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { id: _id, createdAt: _createdAt, ...template } = fixtureApplications[0];

    const created = await client.createApplication(
      {
        ...template,
        company: 'New company',
        roleTitle: 'New role',
        jobUrl: 'https://example.com/jobs/new-role',
        source: 'manual',
      },
      'idempotency-key-1',
    );

    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.source).toBe('manual');
    expect((await client.listApplications())[0]).toEqual(created);
  });

  it('returns the same row for a repeated idempotency key instead of creating a second one', async () => {
    const client = createFixtureDashboardClient(fixtureApplications, fixtureProfile);
    const { id: _id, createdAt: _createdAt, ...template } = fixtureApplications[0];
    const payload = {
      ...template,
      company: 'New company',
      roleTitle: 'New role',
      jobUrl: 'https://example.com/jobs/new-role',
      source: 'manual' as const,
    };

    const first = await client.createApplication(payload, 'retry-key');
    const second = await client.createApplication(payload, 'retry-key');

    expect(second).toEqual(first);
    expect((await client.listApplications()).filter((a) => a.id === first.id)).toHaveLength(1);
  });

  it('reports duplicates for an exact posting URL', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    const existing = fixtureApplications[0];

    await expect(client.findApplicationDuplicates(existing.jobUrl)).resolves.toMatchObject({
      count: 1,
      latest: { id: existing.id },
    });
  });

  it('defaults extractResume to a populated sample draft', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    await expect(client.extractResume(new File(['x'], 'r.pdf'))).resolves.toEqual(
      fixtureExtractedProfile,
    );
  });

  it('resolves extractResume with the extraction a caller configured', async () => {
    const extraction: ExtractedProfile = { ...fixtureExtractedProfile, fullName: 'Ada Lovelace' };
    const client = createFixtureDashboardClient(fixtureApplications, null, {}, { extraction });

    await expect(client.extractResume(new File(['x'], 'r.pdf'))).resolves.toEqual(extraction);
  });

  it('rejects extractResume with a configured error message', async () => {
    const client = createFixtureDashboardClient(
      fixtureApplications,
      null,
      {},
      { error: 'No extractable text was found in this PDF.' },
    );

    await expect(client.extractResume(new File(['x'], 'r.pdf'))).rejects.toThrow(
      'No extractable text was found in this PDF.',
    );
  });

  it('does not hand extractResume out as a reference callers can mutate', async () => {
    const client = createFixtureDashboardClient(fixtureApplications);
    const first = await client.extractResume(new File(['x'], 'r.pdf'));
    first.fullName = 'Mutated';

    const second = await client.extractResume(new File(['x'], 'r.pdf'));
    expect(second.fullName).not.toBe('Mutated');
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
    await expect(client.extractResume(new File(['x'], 'r.pdf'))).rejects.toBeInstanceOf(HttpError);
    await expect(client.extractJob('posting')).rejects.toBeInstanceOf(HttpError);
    await expect(client.findApplicationDuplicates('https://example.com')).rejects.toBeInstanceOf(
      HttpError,
    );
    const { id: _id, createdAt: _createdAt, ...payload } = fixtureApplications[0];
    await expect(client.createApplication(payload, 'idempotency-key-1')).rejects.toBeInstanceOf(
      HttpError,
    );
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
