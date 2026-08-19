/**
 * The dashboard's single copy of the applications, loaded once and shared by both views.
 *
 * The alternative — each view fetching what it needs — makes the two views able to disagree: change
 * a stage from the list card, open that application, and the detail page shows whatever it fetched.
 * Keeping one array above the router means a write is visible everywhere by construction rather
 * than by remembering to invalidate. At this dataset's scale (one person's applications) fetching
 * the list to render one record costs nothing worth designing around.
 *
 * Both mutations are **optimistic**: the local record changes first and the request reconciles
 * afterwards, reverting **that record** on failure. Stage in particular is a single enum a user
 * clicks through quickly, and gating that on a round trip makes the control feel broken. See
 * `mutate` for why the revert is per-record and why it reports whether the write landed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Application, ApplicationStage, NewNote } from '@djobi/shared';
import type { DashboardClient } from './dashboardClient';

export interface ApplicationStore {
  applications: Application[];
  loading: boolean;
  /** A failure to *load*. Write failures surface through `writeError`, which is recoverable. */
  loadError: string | null;
  /** The most recent failed write, or null. Cleared when the next write is attempted. */
  writeError: string | null;
  /** Resolves `true` if the write landed. A failure is reported through `writeError`. */
  updateStage(id: string, stage: ApplicationStage): Promise<boolean>;
  /** Resolves `true` if the note was appended, so a composer knows whether to clear itself. */
  addNote(id: string, note: NewNote): Promise<boolean>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useApplicationStore(client: DashboardClient): ApplicationStore {
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const stageMutationVersions = useRef(new Map<string, number>());
  const stageWriteTails = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    let current = true;

    setLoading(true);
    client
      .listApplications()
      .then((loaded) => {
        if (!current) return;
        setApplications(loaded);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!current) return;
        setLoadError(messageOf(err));
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [client]);

  /**
   * Applies `optimistic` to one record, runs `write`, and reconciles or rolls back only the field
   * this mutation owns.
   *
   * Resolves `true` when the write landed. Callers need that: a form that clears itself on an
   * `await` returning would throw away the user's typing on every failure, because a rejected
   * write is handled here and never reaches them as a rejection.
   *
   * Two details are deliberate and easy to undo by accident.
   *
   * The rollback is field-specific. Restoring a snapshot of either the list or the whole record
   * would undo another write that succeeded while this one was in flight — including a Note and a
   * Stage change racing on the same Application.
   *
   * And the pre-write record is read from `applications` out here rather than captured inside a
   * `setApplications` updater. An updater runs during render, not at call time; with both current
   * call sites being discrete DOM events React happens to flush it before the write's microtask,
   * but from a timer, an effect, or a transition it would not have run yet and the revert would
   * restore `undefined`.
   */
  const mutate = useCallback(
    async <Result>(
      id: string,
      optimistic: (application: Application) => Application,
      write: () => Promise<Result>,
      reconcile: (application: Application, result: Result) => Application,
      rollback: (application: Application, previous: Application) => Application,
      isCurrent: () => boolean = () => true,
    ): Promise<boolean> => {
      const previous = applications.find((a) => a.id === id);
      if (!previous) return false;

      // A retry should not sit behind the last attempt's banner.
      setWriteError(null);
      setApplications((current) => current.map((a) => (a.id === id ? optimistic(a) : a)));

      try {
        const result = await write();
        if (isCurrent()) {
          setApplications((current) =>
            current.map((a) => (a.id === id ? reconcile(a, result) : a)),
          );
        }
        return true;
      } catch (err: unknown) {
        if (isCurrent()) {
          setApplications((current) =>
            current.map((a) => (a.id === id ? rollback(a, previous) : a)),
          );
          setWriteError(messageOf(err));
        }
        return false;
      }
    },
    [applications],
  );

  const updateStage = useCallback(
    (id: string, stage: ApplicationStage) => {
      const version = (stageMutationVersions.current.get(id) ?? 0) + 1;
      stageMutationVersions.current.set(id, version);

      return mutate(
        id,
        (a) => ({ ...a, stage }),
        () => {
          const previousWrite = stageWriteTails.current.get(id) ?? Promise.resolve();
          const request = previousWrite.then(() => client.updateStage(id, stage));
          const tail = request.then(
            () => undefined,
            () => undefined,
          );

          stageWriteTails.current.set(id, tail);
          void tail.then(() => {
            if (stageWriteTails.current.get(id) === tail) stageWriteTails.current.delete(id);
          });

          return request;
        },
        (a, result) => ({ ...a, stage: result.stage }),
        (a, previous) => (a.stage === stage ? { ...a, stage: previous.stage } : a),
        () => stageMutationVersions.current.get(id) === version,
      );
    },
    [client, mutate],
  );

  const addNote = useCallback(
    (id: string, note: NewNote) => {
      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      return mutate(
        id,
        (a) => ({
          ...a,
          // The optimistic note carries placeholder server fields. It exists only until the real
          // record replaces it, and the `id` is prefixed so it can never be mistaken for a real one.
          notes: [...a.notes, { ...note, id: optimisticId, createdAt: new Date().toISOString() }],
        }),
        () => client.addNote(id, note),
        (a, result) => ({
          ...a,
          notes: [...a.notes.filter((existing) => existing.id !== optimisticId), result.note],
        }),
        (a) => ({
          ...a,
          notes: a.notes.filter((existing) => existing.id !== optimisticId),
        }),
      );
    },
    [client, mutate],
  );

  return { applications, loading, loadError, writeError, updateStage, addNote };
}
