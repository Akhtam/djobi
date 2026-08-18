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
import { useCallback, useEffect, useState } from 'react';
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
   * Applies `optimistic` to one record, runs `write`, and either replaces that record with the
   * server's version or puts back exactly what was there before.
   *
   * Resolves `true` when the write landed. Callers need that: a form that clears itself on an
   * `await` returning would throw away the user's typing on every failure, because a rejected
   * write is handled here and never reaches them as a rejection.
   *
   * Two details are deliberate and easy to undo by accident.
   *
   * The revert replaces **only this record**, not the whole array. Restoring a snapshot of the
   * list would also undo any *other* write that succeeded while this one was in flight — change
   * one application's stage on a slow connection, change a second one, and the second silently
   * flips back when the first fails.
   *
   * And the pre-write record is read from `applications` out here rather than captured inside a
   * `setApplications` updater. An updater runs during render, not at call time; with both current
   * call sites being discrete DOM events React happens to flush it before the write's microtask,
   * but from a timer, an effect, or a transition it would not have run yet and the revert would
   * restore `undefined`.
   */
  const mutate = useCallback(
    async (
      id: string,
      optimistic: (application: Application) => Application,
      write: () => Promise<Application>,
    ): Promise<boolean> => {
      const previous = applications.find((a) => a.id === id);
      if (!previous) return false;

      // A retry should not sit behind the last attempt's banner.
      setWriteError(null);
      setApplications((current) => current.map((a) => (a.id === id ? optimistic(a) : a)));

      try {
        const saved = await write();
        setApplications((current) => current.map((a) => (a.id === id ? saved : a)));
        return true;
      } catch (err: unknown) {
        setApplications((current) => current.map((a) => (a.id === id ? previous : a)));
        setWriteError(messageOf(err));
        return false;
      }
    },
    [applications],
  );

  const updateStage = useCallback(
    (id: string, stage: ApplicationStage) =>
      mutate(
        id,
        (a) => ({ ...a, stage }),
        () => client.updateStage(id, stage),
      ),
    [client, mutate],
  );

  const addNote = useCallback(
    (id: string, note: NewNote) =>
      mutate(
        id,
        (a) => ({
          ...a,
          // The optimistic note carries placeholder server fields. It exists only until the real
          // record replaces it, and the `id` is prefixed so it can never be mistaken for a real one.
          notes: [
            ...a.notes,
            { ...note, id: `optimistic-${Date.now()}`, createdAt: new Date().toISOString() },
          ],
        }),
        () => client.addNote(id, note),
      ),
    [client, mutate],
  );

  return { applications, loading, loadError, writeError, updateStage, addNote };
}
