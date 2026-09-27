/**
 * The dashboard's single copy of the applications, loaded once and shared by every view, so a write
 * shows everywhere without invalidation.
 *
 * Mutations are **optimistic**: the record changes first and reverts (that record only) on failure.
 * See {@link Mutation}.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnauthorized, userMessage } from '@djobi/http-client';
import {
  type Application,
  type ApplicationStage,
  type NewApplicationRequest,
  type NewNote,
} from '@djobi/shared';
import type { DashboardClient } from './dashboardClient';

export interface ApplicationStore {
  applications: Application[];
  loading: boolean;
  /** A failure to *load*. Write failures surface through `writeError`, which is recoverable. */
  loadError: string | null;
  /** The most recent failed write, or null. Cleared when the next write is attempted. */
  writeError: string | null;
  /**
   * Set when a load or write got a 401 (instead of `loadError`/`writeError`). `App` turns it into a
   * redirect to `#/login`.
   */
  unauthorized: boolean;
  /**
   * Clears session-owned data and asks `App` to route to sign-in after a 401 outside this store.
   */
  reportUnauthorized(): void;
  /** Resolves `true` if the write landed. A failure is reported through `writeError`. */
  updateStage(id: string, stage: ApplicationStage): Promise<boolean>;
  /** Resolves `true` if the note was appended, so a composer knows whether to clear itself. */
  addNote(id: string, note: NewNote): Promise<boolean>;
  /** Resolves `true` if the note was removed; a failure puts it back and reports `writeError`. */
  deleteNote(id: string, noteId: string): Promise<boolean>;
  /** Removes an Application; resolves whether it landed (a failure restores the row). */
  deleteApplication(id: string): Promise<boolean>;
  /**
   * Creates and inserts a full row, or resolves `null` after reporting the failure.
   * `idempotencyKey` passes through to `DashboardClient.createApplication`.
   */
  createApplication(
    payload: NewApplicationRequest,
    idempotencyKey: string,
  ): Promise<Application | null>;
  /**
   * Re-fetches and clears `unauthorized` — called after a fresh sign-in, so a 401 from the new
   * session can fire again.
   */
  reload(): void;
}

/**
 * One optimistic change to one Application.
 *
 * A **slotted** mutation owns a single-value field (Stage): writes to one slot are queued in order
 * and only the newest's answer is applied. An **unslotted** one owns something nothing else touches
 * (its own Note, found by optimistic id) — independent, neither queued nor superseded.
 */
interface Mutation<Result> {
  id: string;
  /** The field this mutation claims, when only one value can occupy it. Omit if it claims none. */
  slot?: string;
  /** The record as it should read immediately, before the server has answered. */
  apply(application: Application): Application;
  write(): Promise<Result>;
  /** The record once the server has answered — for the fields this mutation owns, and no others. */
  reconcile(application: Application, result: Result): Application;
  /** Undoes `apply`, given the record as it was before it. Must not restore unrelated fields. */
  rollback(application: Application, previous: Application): Application;
}

export function useApplicationStore(client: DashboardClient): ApplicationStore {
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  // Bumped by `reload()` to force the fetch effect below to run again — `client` alone does not
  // change across a sign-in, since `App` holds one client instance for the app's whole lifetime.
  const [reloadToken, setReloadToken] = useState(0);
  // Per slot: the newest mutation's version and the write it queues behind.
  const slotVersions = useRef(new Map<string, number>());
  const slotWriteTails = useRef(new Map<string, Promise<void>>());

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
        if (isUnauthorized(err)) {
          // Nothing this session loaded is this signed-out browser's to keep showing.
          setApplications([]);
          setUnauthorized(true);
        } else {
          setLoadError(userMessage(err));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [client, reloadToken]);

  const reload = useCallback(() => {
    setUnauthorized(false);
    setReloadToken((token) => token + 1);
  }, []);

  const reportUnauthorized = useCallback(() => {
    setApplications([]);
    setUnauthorized(true);
  }, []);

  /**
   * Runs a write behind whatever is queued for its slot, preserving user order. Unslotted writes go
   * straight out.
   */
  const enqueue = useCallback(<Result>(key: string | null, write: () => Promise<Result>) => {
    if (key === null) return write();

    const previousWrite = slotWriteTails.current.get(key) ?? Promise.resolve();
    const request = previousWrite.then(write);
    const tail = request.then(
      () => undefined,
      () => undefined,
    );

    slotWriteTails.current.set(key, tail);
    void tail.then(() => {
      if (slotWriteTails.current.get(key) === tail) slotWriteTails.current.delete(key);
    });

    return request;
  }, []);

  /**
   * Applies `apply` to one record, runs `write`, then reconciles or rolls back only what this
   * mutation owns. Resolves `true` if the write landed (failures are handled here, never rejected).
   *
   * - Ordering and staleness are keyed by {@link Mutation.slot}.
   * - Rollback is field-specific, so a concurrent successful write (e.g. a Note beside a Stage
   *   change) isn't undone.
   * - The pre-write record is read here, not inside a `setApplications` updater, which may not have
   *   run yet when called from a timer or effect.
   */
  const mutate = useCallback(
    async <Result>({
      id,
      slot,
      apply,
      write,
      reconcile,
      rollback,
    }: Mutation<Result>): Promise<boolean> => {
      const previous = applications.find((a) => a.id === id);
      if (!previous) return false;

      const key = slot === undefined ? null : `${id}:${slot}`;
      let version = 0;
      if (key !== null) {
        version = (slotVersions.current.get(key) ?? 0) + 1;
        slotVersions.current.set(key, version);
      }
      /** False once a later mutation has claimed the same slot — its answer is the current one. */
      const isCurrent = () => key === null || slotVersions.current.get(key) === version;

      // A retry should not sit behind the last attempt's banner.
      setWriteError(null);
      setApplications((current) => current.map((a) => (a.id === id ? apply(a) : a)));

      try {
        const result = await enqueue(key, write);
        if (isCurrent()) {
          setApplications((current) =>
            current.map((a) => (a.id === id ? reconcile(a, result) : a)),
          );
        }
        return true;
      } catch (err: unknown) {
        if (isCurrent()) {
          if (isUnauthorized(err)) {
            // The optimistic change was never real — nothing this session holds is this signed-out
            // browser's to keep showing, the record it was applied to included.
            setApplications([]);
            setUnauthorized(true);
          } else {
            setApplications((current) =>
              current.map((a) => (a.id === id ? rollback(a, previous) : a)),
            );
            setWriteError(userMessage(err));
          }
        }
        return false;
      }
    },
    [applications, enqueue],
  );

  const updateStage = useCallback(
    (id: string, stage: ApplicationStage) =>
      mutate({
        id,
        slot: 'stage',
        apply: (a) => ({ ...a, stage }),
        write: () => client.updateStage(id, stage),
        reconcile: (a, result) => ({ ...a, stage: result.stage }),
        // Only if this mutation's Stage is still the one showing. A newer click has already put its
        // own Stage there, and that one is not this failure's to undo.
        rollback: (a, previous) => (a.stage === stage ? { ...a, stage: previous.stage } : a),
      }),
    [client, mutate],
  );

  const addNote = useCallback(
    (id: string, note: NewNote) => {
      // What makes this mutation unslotted: it owns exactly the Note carrying this id, so it can
      // find its own work again however many other Notes land while the write is in flight.
      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      return mutate({
        id,
        apply: (a) => ({
          ...a,
          // The optimistic note carries placeholder server fields. It exists only until the real
          // record replaces it, and the `id` is prefixed so it can never be mistaken for a real
          // one.
          notes: [...a.notes, { ...note, id: optimisticId, createdAt: new Date().toISOString() }],
        }),
        write: () => client.addNote(id, note),
        reconcile: (a, result) => ({
          ...a,
          notes: [...a.notes.filter((existing) => existing.id !== optimisticId), result.note],
        }),
        rollback: (a) => ({
          ...a,
          notes: a.notes.filter((existing) => existing.id !== optimisticId),
        }),
      });
    },
    [client, mutate],
  );

  const deleteNote = useCallback(
    (id: string, noteId: string) => {
      // Unslotted: this mutation owns exactly the Note with this id.
      return mutate({
        id,
        apply: (a) => ({ ...a, notes: a.notes.filter((note) => note.id !== noteId) }),
        write: () => client.deleteNote(id, noteId),
        // Nothing to reconcile; keeping the optimistic row preserves Notes appended meanwhile.
        reconcile: (a) => a,
        // Reinsert into the log as it now stands (not `previous.notes` wholesale, which would drop
        // Notes appended meanwhile), at the index from `previous`.
        rollback: (a, previous) => {
          const index = previous.notes.findIndex((note) => note.id === noteId);
          const removed = previous.notes[index];
          if (!removed || a.notes.some((note) => note.id === noteId)) return a;

          const notes = [...a.notes];
          notes.splice(index, 0, removed);
          return { ...a, notes };
        },
      });
    },
    [client, mutate],
  );

  /**
   * Removes a whole row (so not via `mutate`): gone immediately, restored at its original index on
   * failure.
   */
  const deleteApplication = useCallback(
    async (id: string): Promise<boolean> => {
      const index = applications.findIndex((a) => a.id === id);
      const previous = applications[index];
      if (!previous) return false;

      setWriteError(null);
      setApplications((current) => current.filter((a) => a.id !== id));

      try {
        await client.deleteApplication(id);
        return true;
      } catch (err: unknown) {
        if (isUnauthorized(err)) {
          setApplications([]);
          setUnauthorized(true);
        } else {
          setApplications((current) => {
            if (current.some((a) => a.id === id)) return current;
            const restored = [...current];
            restored.splice(Math.min(index, restored.length), 0, previous);
            return restored;
          });
          setWriteError(userMessage(err));
        }
        return false;
      }
    },
    [applications, client],
  );

  const createApplication = useCallback(
    async (payload: NewApplicationRequest, idempotencyKey: string): Promise<Application | null> => {
      setWriteError(null);
      try {
        const created = await client.createApplication(payload, idempotencyKey);
        setApplications((current) => [
          created,
          ...current.filter((item) => item.id !== created.id),
        ]);
        return created;
      } catch (err: unknown) {
        if (isUnauthorized(err)) {
          setApplications([]);
          setUnauthorized(true);
        } else {
          setWriteError(userMessage(err));
        }
        return null;
      }
    },
    [client],
  );

  return {
    applications,
    loading,
    loadError,
    writeError,
    unauthorized,
    reportUnauthorized,
    updateStage,
    addNote,
    deleteNote,
    deleteApplication,
    createApplication,
    reload,
  };
}
