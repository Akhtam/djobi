/**
 * The store at its own interface.
 *
 * Its hardest rules — write ordering, staleness, and a rollback that touches only what one mutation
 * owns — are about what happens *between* two writes to one Application. Reaching them through the
 * app's DOM means racing two clicks and asserting on rendered text; here they are stated directly,
 * which is where they belong now that the store owns them rather than one of its callers.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '@djobi/http-client';
import type { Application, ApplicationStage, NewNote } from '@djobi/shared';
import type { DashboardClient } from './dashboardClient';
import { fixtureApplications } from './fixtures';
import { useApplicationStore } from './useApplicationStore';

const [seed] = fixtureApplications;
const application: Application = { ...structuredClone(seed), id: 'app-1', stage: 'applied' };

const note: NewNote = { category: 'general', text: 'Recruiter call booked.' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A client whose writes a test resolves by hand, so two can be in flight at once. */
function client(overrides: Partial<DashboardClient> = {}): DashboardClient {
  return {
    listApplications: () => Promise.resolve([structuredClone(application)]),
    extractJob: () => Promise.resolve(structuredClone(application.jobInfo)),
    createApplication: () => Promise.resolve(structuredClone(application)),
    findApplicationDuplicates: () => Promise.resolve({ count: 0, latest: null }),
    updateStage: (id, stage) => Promise.resolve({ id, stage }),
    deleteNote: (id, noteId) => Promise.resolve({ id, noteId }),
    deleteApplication: (id) => Promise.resolve({ id }),
    addNote: (id, appended) =>
      Promise.resolve({
        id,
        note: { ...appended, id: `note-${Math.random()}`, createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    getProfile: () => Promise.resolve(null),
    saveProfile: (profile) => Promise.resolve(profile),
    extractResume: () => Promise.reject(new Error('not used in this suite')),
    signIn: () => Promise.resolve(),
    signUp: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    ...overrides,
  };
}

async function loadedStore(dashboardClient: DashboardClient) {
  const { result } = renderHook(() => useApplicationStore(dashboardClient));
  await waitFor(() => expect(result.current.loading).toBe(false));
  return result;
}

describe('useApplicationStore', () => {
  it('inserts a newly created application into the shared list', async () => {
    const created = { ...structuredClone(application), id: 'app-created', company: 'New company' };
    const store = await loadedStore(client({ createApplication: () => Promise.resolve(created) }));

    await act(async () => {
      await store.current.createApplication(
        {
          company: created.company,
          roleTitle: created.roleTitle,
          jobUrl: created.jobUrl,
          jobInfo: created.jobInfo,
          tailoredResume: created.tailoredResume,
          answers: [],
          source: 'manual',
        },
        'idempotency-key-1',
      );
    });

    expect(store.current.applications[0]).toEqual(created);
  });

  it('shows a new Stage before the server has answered', async () => {
    const write = deferred<{ id: string; stage: ApplicationStage }>();
    const store = await loadedStore(client({ updateStage: () => write.promise }));

    act(() => void store.current.updateStage('app-1', 'onsite'));

    expect(store.current.applications[0].stage).toBe('onsite');
  });

  it('puts the Stage back when the write fails, and says why', async () => {
    const store = await loadedStore(
      client({ updateStage: () => Promise.reject(new Error('Backend unreachable')) }),
    );

    await act(async () => {
      await store.current.updateStage('app-1', 'onsite');
    });

    expect(store.current.applications[0].stage).toBe('applied');
    expect(store.current.writeError).toBe('Backend unreachable');
  });

  /**
   * Clicking through the Stages faster than the network answers. The server must see them in the
   * order they were made, or the record settles on whichever write happened to finish last.
   */
  it('sends two Stage writes for one Application in the order they were made', async () => {
    const first = deferred<{ id: string; stage: ApplicationStage }>();
    const order: ApplicationStage[] = [];
    const updateStage = vi.fn((id: string, stage: ApplicationStage) => {
      order.push(stage);
      return stage === 'phone_screen' ? first.promise : Promise.resolve({ id, stage });
    });
    const store = await loadedStore(client({ updateStage }));

    act(() => void store.current.updateStage('app-1', 'phone_screen'));
    await act(async () => undefined);
    expect(order).toEqual(['phone_screen']);

    act(() => void store.current.updateStage('app-1', 'onsite'));
    await act(async () => undefined);
    // Still nothing new: the second write is queued behind the first, which hasn't answered.
    expect(order).toEqual(['phone_screen']);

    await act(async () => {
      first.resolve({ id: 'app-1', stage: 'phone_screen' });
      await first.promise;
    });

    await waitFor(() => expect(order).toEqual(['phone_screen', 'onsite']));
  });

  /** A superseded write's authoritative Stage is a stale Stage — applying it undoes a later click. */
  it('ignores a superseded Stage write when it answers', async () => {
    const first = deferred<{ id: string; stage: ApplicationStage }>();
    const store = await loadedStore(
      client({
        updateStage: (id, stage) =>
          stage === 'phone_screen' ? first.promise : Promise.resolve({ id, stage }),
      }),
    );

    act(() => void store.current.updateStage('app-1', 'phone_screen'));
    act(() => void store.current.updateStage('app-1', 'onsite'));
    await act(async () => {
      first.resolve({ id: 'app-1', stage: 'phone_screen' });
      await first.promise;
    });

    await waitFor(() => expect(store.current.applications[0].stage).toBe('onsite'));
  });

  /** The same rule on the failure path: a stale rollback would undo the newer click. */
  it('does not roll back a Stage a later write has already replaced', async () => {
    const first = deferred<{ id: string; stage: ApplicationStage }>();
    const store = await loadedStore(
      client({
        updateStage: (id, stage) =>
          stage === 'phone_screen' ? first.promise : Promise.resolve({ id, stage }),
      }),
    );

    act(() => void store.current.updateStage('app-1', 'phone_screen'));
    act(() => void store.current.updateStage('app-1', 'onsite'));
    await act(async () => {
      first.reject(new Error('Backend unreachable'));
      await first.promise.catch(() => undefined);
    });

    expect(store.current.applications[0].stage).toBe('onsite');
  });

  it("appends a Note and replaces it with the server's record", async () => {
    const store = await loadedStore(client());

    await act(async () => {
      expect(await store.current.addNote('app-1', note)).toBe(true);
    });

    const [{ notes }] = store.current.applications;
    expect(notes.at(-1)?.text).toBe('Recruiter call booked.');
    expect(notes.at(-1)?.id).not.toMatch(/^optimistic-/);
  });

  /**
   * Notes are unslotted: each mutation owns the Note it appended and nothing else. Two in flight
   * together must both reconcile — treating the older one as superseded would strand its
   * placeholder on screen forever.
   */
  it('reconciles both of two Notes added before either write answers', async () => {
    const first = deferred<Awaited<ReturnType<DashboardClient['addNote']>>>();
    let call = 0;
    const store = await loadedStore(
      client({
        addNote: (id, appended) => {
          const answer = {
            id,
            note: { ...appended, id: `note-${call}`, createdAt: '2026-01-01T00:00:00.000Z' },
          };
          return call++ === 0 ? first.promise : Promise.resolve(answer);
        },
      }),
    );

    let second!: Promise<boolean>;
    act(() => void store.current.addNote('app-1', note));
    act(() => {
      second = store.current.addNote('app-1', { ...note, text: 'Second note.' });
    });
    await act(async () => {
      first.resolve({
        id: 'app-1',
        note: { ...note, id: 'note-0', createdAt: '2026-01-01T00:00:00.000Z' },
      });
      await second;
    });

    await waitFor(() => {
      const [{ notes }] = store.current.applications;
      expect(notes.filter((n) => n.id.startsWith('optimistic-'))).toEqual([]);
      expect(notes.map((n) => n.text)).toContain('Second note.');
    });
  });

  it('removes a Note optimistically and keeps it gone once the write lands', async () => {
    const store = await loadedStore(client());
    await act(async () => void (await store.current.addNote('app-1', note)));
    const [{ notes }] = store.current.applications;
    const target = notes.at(-1)!;

    await act(async () => {
      expect(await store.current.deleteNote('app-1', target.id)).toBe(true);
    });

    expect(store.current.applications[0].notes).toEqual([]);
  });

  it('puts a deleted Note back, in its own place, when the write fails', async () => {
    // The one that matters: an optimistic delete that the backend refuses must not quietly lose an
    // entry, which is the exact loss the append-only log exists to prevent. Order is asserted
    // because a note restored at the end of the log is a note with the wrong history around it.
    const store = await loadedStore(
      client({ deleteNote: () => Promise.reject(new Error('Backend unreachable')) }),
    );
    await act(async () => void (await store.current.addNote('app-1', note)));
    await act(
      async () => void (await store.current.addNote('app-1', { ...note, text: 'Second note.' })),
    );
    const [first, second] = store.current.applications[0].notes;

    await act(async () => {
      expect(await store.current.deleteNote('app-1', first.id)).toBe(false);
    });

    expect(store.current.applications[0].notes.map((n) => n.text)).toEqual([
      first.text,
      second.text,
    ]);
  });

  it('keeps a Note that landed while a failing delete was in flight', async () => {
    // The same rule as the Stage rollback below, on the operation where breaking it would silently
    // discard something the candidate wrote: restoring the record's whole note list would undo the
    // append too.
    const failing = deferred<{ id: string; noteId: string }>();
    const store = await loadedStore(client({ deleteNote: () => failing.promise }));
    await act(async () => void (await store.current.addNote('app-1', note)));
    const doomed = store.current.applications[0].notes[0];

    let deleting!: Promise<boolean>;
    act(() => {
      deleting = store.current.deleteNote('app-1', doomed.id);
    });
    await act(async () => void (await store.current.addNote('app-1', { ...note, text: 'Later.' })));
    await act(async () => {
      failing.reject(new Error('Backend unreachable'));
      await deleting;
    });

    expect(store.current.applications[0].notes.map((n) => n.text)).toEqual([doomed.text, 'Later.']);
  });

  it('removes an Application optimistically and keeps it gone once the write lands', async () => {
    const store = await loadedStore(client());

    await act(async () => {
      expect(await store.current.deleteApplication('app-1')).toBe(true);
    });

    expect(store.current.applications).toEqual([]);
  });

  it('puts a deleted Application back at its original index when the write fails', async () => {
    const second = { ...structuredClone(application), id: 'app-2', company: 'Second' };
    const store = await loadedStore(
      client({
        listApplications: () => Promise.resolve([structuredClone(application), second]),
        deleteApplication: () => Promise.reject(new Error('Backend unreachable')),
      }),
    );

    await act(async () => {
      expect(await store.current.deleteApplication('app-1')).toBe(false);
    });

    expect(store.current.applications.map((a) => a.id)).toEqual(['app-1', 'app-2']);
  });

  /**
   * The reason the rollback is field-specific rather than a snapshot of the record: a failed Stage
   * write must not take a Note that landed while it was in flight down with it.
   */
  it('keeps a Note that landed while a failing Stage write was in flight', async () => {
    const stageWrite = deferred<{ id: string; stage: ApplicationStage }>();
    const store = await loadedStore(client({ updateStage: () => stageWrite.promise }));

    let stage!: Promise<boolean>;
    act(() => {
      stage = store.current.updateStage('app-1', 'onsite');
    });
    await act(async () => {
      await store.current.addNote('app-1', note);
    });
    await act(async () => {
      stageWrite.reject(new Error('Backend unreachable'));
      await stage;
    });

    const [record] = store.current.applications;
    expect(record.stage).toBe('applied');
    expect(record.notes.at(-1)?.text).toBe('Recruiter call booked.');
  });

  it('reports a failure to load without pretending there are no applications to write to', async () => {
    const store = await loadedStore(
      client({ listApplications: () => Promise.reject(new Error('Backend unreachable')) }),
    );

    expect(store.current.loadError).toBe('Backend unreachable');
    expect(await store.current.updateStage('app-1', 'onsite')).toBe(false);
  });

  /** A 401 is "go sign in again," not "the backend is broken" — see `isUnauthorized`. */
  function unauthorizedError() {
    return new HttpError('http', '/applications', 'GET /applications failed (401)', 401);
  }

  it('flags unauthorized rather than a generic load error on a 401, and clears the list', async () => {
    const store = await loadedStore(
      client({ listApplications: () => Promise.reject(unauthorizedError()) }),
    );

    expect(store.current.unauthorized).toBe(true);
    expect(store.current.loadError).toBeNull();
    expect(store.current.applications).toEqual([]);
  });

  it('flags unauthorized rather than a generic write error on a 401, and clears the list', async () => {
    const store = await loadedStore(
      client({ updateStage: () => Promise.reject(unauthorizedError()) }),
    );

    await act(async () => {
      await store.current.updateStage('app-1', 'onsite');
    });

    expect(store.current.unauthorized).toBe(true);
    expect(store.current.writeError).toBeNull();
    expect(store.current.applications).toEqual([]);
  });

  it('reports a 401 from a request outside the store and clears the list', async () => {
    const store = await loadedStore(client());

    act(() => store.current.reportUnauthorized());

    expect(store.current.unauthorized).toBe(true);
    expect(store.current.applications).toEqual([]);
  });

  it('reload() re-fetches and clears unauthorized, so a fresh 401 can flag it again', async () => {
    const listApplications = vi
      .fn()
      .mockRejectedValueOnce(unauthorizedError())
      .mockResolvedValueOnce([structuredClone(application)])
      .mockRejectedValueOnce(unauthorizedError());
    const store = await loadedStore(client({ listApplications }));
    expect(store.current.unauthorized).toBe(true);

    act(() => void store.current.reload());
    await waitFor(() => expect(store.current.loading).toBe(false));
    expect(store.current.unauthorized).toBe(false);
    expect(store.current.applications).toEqual([application]);

    act(() => void store.current.reload());
    await waitFor(() => expect(store.current.unauthorized).toBe(true));
  });
});
