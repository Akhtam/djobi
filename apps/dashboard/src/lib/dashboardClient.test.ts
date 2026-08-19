import { describe, expect, it } from 'vitest';
import { createFixtureDashboardClient } from './dashboardClient';
import { fixtureApplications } from './fixtures';

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
    await client.updateStage('app-sonar', 'interviewing');

    const listed = await client.listApplications();
    expect(listed.find((a) => a.id === 'app-sonar')?.stage).toBe('interviewing');
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
});
