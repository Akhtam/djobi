/**
 * Writes that can fail or race: optimistic stage changes and note saves, queued and reverted
 * against a client whose promises this file resolves/rejects by hand via `deferred`. The
 * happy-path versions of these same controls live in `application-detail`.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureDashboardClient, type DashboardClient } from '../lib/dashboardClient';
import { fixtureApplications } from '../lib/fixtures';
import { deferred, renderDashboard } from './test-utils';

describe('failures', () => {
  it('persists rapid stage changes in user action order while keeping the latest optimistic UI', async () => {
    type StageResult = Awaited<ReturnType<DashboardClient['updateStage']>>;
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const first = deferred<StageResult>();
    const second = deferred<StageResult>();
    const calls: string[] = [];
    const client: DashboardClient = {
      ...fixture,
      updateStage: (_id, stage) => {
        calls.push(stage);
        return stage === 'applied' ? first.promise : second.promise;
      },
    };

    const { user } = renderDashboard({ client, hash: '#/applications/app-brex' });
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'applied');
    await user.selectOptions(picker, 'rejected');

    expect(picker).toHaveValue('rejected');
    expect(calls).toEqual(['applied']);

    first.resolve({ id: 'app-brex', stage: 'applied' });
    await waitFor(() => expect(calls).toEqual(['applied', 'rejected']));
    expect(picker).toHaveValue('rejected');

    await act(async () => {
      second.resolve({ id: 'app-brex', stage: 'rejected' });
    });

    expect(picker).toHaveValue('rejected');
    expect(calls.at(-1)).toBe('rejected');
  });

  it('starts a newer queued stage after the first fails without reverting the latest UI', async () => {
    type StageResult = Awaited<ReturnType<DashboardClient['updateStage']>>;
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const first = deferred<StageResult>();
    const second = deferred<StageResult>();
    const calls: string[] = [];
    const client: DashboardClient = {
      ...fixture,
      updateStage: (_id, stage) => {
        calls.push(stage);
        return stage === 'applied' ? first.promise : second.promise;
      },
    };

    const { user } = renderDashboard({ client, hash: '#/applications/app-brex' });
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'applied');
    await user.selectOptions(picker, 'rejected');
    expect(calls).toEqual(['applied']);

    first.reject(new Error('stale failure'));
    await waitFor(() => expect(calls).toEqual(['applied', 'rejected']));

    expect(picker).toHaveValue('rejected');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      second.resolve({ id: 'app-brex', stage: 'rejected' });
    });

    expect(picker).toHaveValue('rejected');
    expect(calls.at(-1)).toBe('rejected');
  });

  it('reverts an optimistic stage change and says why', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const failing: DashboardClient = {
      ...fixture,
      updateStage: () => Promise.reject(new Error('Phase 7 has not built this route')),
    };

    const { user } = renderDashboard({ client: failing, hash: '#/applications/app-brex' });
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });
    await user.selectOptions(picker, 'rejected');

    expect(await screen.findByRole('alert')).toHaveTextContent('Phase 7 has not built this route');
    // The change is undone, not left showing a value the server rejected.
    await waitFor(() => expect(picker).toHaveValue('onsite'));
  });

  it('keeps the typed note when the save fails, rather than throwing the user’s text away', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    const failing: DashboardClient = {
      ...fixture,
      addNote: () => Promise.reject(new Error('Phase 7 has not built this route')),
    };

    const { user } = renderDashboard({ client: failing, hash: '#/applications/app-brex' });
    await screen.findByRole('heading', { name: 'Brex · Infrastructure · Remote (US)' });
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    const textarea = screen.getByRole('textbox', { name: 'Note' });
    await user.type(textarea, 'Worth not losing.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Phase 7 has not built this route');
    expect(textarea).toHaveValue('Worth not losing.');
  });

  it('does not undo a different write that already succeeded', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    type StageResult = Awaited<ReturnType<DashboardClient['updateStage']>>;
    const brexWrite = deferred<StageResult>();
    const calls: string[] = [];
    const failing: DashboardClient = {
      ...fixture,
      updateStage: (id, stage) => {
        calls.push(id);
        return id === 'app-brex' ? brexWrite.promise : fixture.updateStage(id, stage);
      },
    };

    const { user } = renderDashboard({ client: failing });
    await screen.findByRole('link', { name: 'Senior Frontend Engineer' });

    const brex = screen.getByRole('combobox', { name: /Stage for Senior Frontend Engineer/ });
    const sonar = screen.getByRole('combobox', { name: /Stage for Staff Engineer, Platform/ });

    await user.selectOptions(brex, 'rejected');
    await user.selectOptions(sonar, 'onsite');

    // A pending write for one application does not block another application's queue.
    expect(calls).toEqual(['app-brex', 'app-sonar']);
    await waitFor(() => expect(sonar).toHaveValue('onsite'));

    brexWrite.reject(new Error('nope'));
    // The failing write reverts its own record...
    await waitFor(() => expect(brex).toHaveValue('onsite'));
    // ...and leaves the one that succeeded alone.
    expect(sonar).toHaveValue('onsite');
  });

  it('clears a previous failure when the next write is attempted', async () => {
    const fixture = createFixtureDashboardClient(fixtureApplications);
    let failNext = true;
    const flaky: DashboardClient = {
      ...fixture,
      updateStage: (id, stage) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('transient'));
        }
        return fixture.updateStage(id, stage);
      },
    };

    const { user } = renderDashboard({ client: flaky, hash: '#/applications/app-brex' });
    const picker = await screen.findByRole('combobox', { name: 'Application stage' });

    await user.selectOptions(picker, 'rejected');
    expect(await screen.findByRole('alert')).toHaveTextContent('transient');

    await user.selectOptions(picker, 'rejected');

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('reports a failure to load rather than showing an empty list', async () => {
    renderDashboard({
      client: {
        listApplications: () => Promise.reject(new Error('backend is not running')),
        extractJob: () => Promise.reject(new Error('unused')),
        createApplication: () => Promise.reject(new Error('unused')),
        findApplicationDuplicates: () => Promise.reject(new Error('unused')),
        updateStage: () => Promise.reject(new Error('unused')),
        addNote: () => Promise.reject(new Error('unused')),
        getProfile: () => Promise.reject(new Error('unused')),
        saveProfile: () => Promise.reject(new Error('unused')),
        signIn: () => Promise.reject(new Error('unused')),
        signUp: () => Promise.reject(new Error('unused')),
        signOut: () => Promise.reject(new Error('unused')),
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('backend is not running');
  });
});
