/**
 * The dashboard's single copy of the applications, loaded once and shared by both views.
 *
 * The alternative — each view fetching what it needs — makes the two views able to disagree: change
 * a stage from the list row, open that application, and the detail page shows whatever it fetched.
 * Keeping one array above the router means a write is visible everywhere by construction rather
 * than by remembering to invalidate. At this dataset's scale (one person's applications) fetching
 * the list to render one record costs nothing worth designing around.
 *
 * Both mutations are **optimistic**: the local record changes first and the request reconciles
 * afterwards, reverting **that record** on failure. Stage in particular is a single enum a user
 * clicks through quickly, and gating that on a round trip makes the control feel broken. See
 * {@link Mutation} for why the revert is per-record and why it reports whether the write landed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  failureMessage,
  type Application,
  type ApplicationStage,
  type NewApplicationRequest,
  type NewNote,
} from '@djobi/shared';
import { isUnauthorized } from './dashboardSession';
import type { DashboardClient } from './dashboardClient';

export interface ApplicationStore {
  applications: Application[];
  loading: boolean;
  /** A failure to *load*. Write failures surface through `writeError`, which is recoverable. */
  loadError: string | null;
  /** The most recent failed write, or null. Cleared when the next write is attempted. */
  writeError: string | null;
  /**
   * Set when a load or a write came back 401, instead of `loadError`/`writeError` — an expired or
   * missing session is not "the backend is broken," it is "go sign in again," and a generic banner
   * is the wrong answer for both. `App` is what turns this into an actual redirect to `#/login`; the
   * store only knows that the session it had is no longer good.
   */
  unauthorized: boolean;
  /** Clears session-owned data and asks `App` to route to sign-in after a 401 outside this store. */
  reportUnauthorized(): void;
  /** Resolves `true` if the write landed. A failure is reported through `writeError`. */
  updateStage(id: string, stage: ApplicationStage): Promise<boolean>;
  /** Resolves `true` if the note was appended, so a composer knows whether to clear itself. */
  addNote(id: string, note: NewNote): Promise<boolean>;
  /** Resolves `true` if the note was removed; a failure puts it back and reports `writeError`. */
  deleteNote(id: string, noteId: string): Promise<boolean>;
  /** Creates and inserts a full row, or resolves null after reporting the failed write. */
  createApplication(payload: NewApplicationRequest): Promise<Application | null>;
  /**
   * Re-fetches from scratch and clears `unauthorized` — what `App` calls once a fresh sign-in has
   * replaced the session that expired. Resetting `unauthorized` here, rather than the instant a 401
   * is reported, is what lets it fire again if the *new* session also turns out to be no good.
   */
  reload(): void;
}

/**
 * One optimistic change to one Application.
 *
 * `slot` is what separates the two kinds of mutation this store makes, and it replaces the
 * ordering and staleness bookkeeping callers used to do for themselves.
 *
 * A **slotted** mutation claims a field only one value can occupy — a Stage. Clicking through
 * `applied → phone_screen → onsite` faster than the network answers means three writes for
 * one field: they are queued so the server sees them in that order, and only the newest one's
 * answer is applied, because an earlier write's authoritative Stage is a stale Stage.
 *
 * An **unslotted** mutation owns something no other mutation touches — a Note it appended, which it
 * finds again by its own optimistic id. Two of those are independent, so they neither queue behind
 * one another nor supersede one another. Giving Notes a slot would be actively wrong: the older
 * mutation would skip its reconcile and leave its placeholder Note on screen forever.
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
  // Per slot (see {@link Mutation.slot}): which mutation is the newest, and the write it queues
  // behind. Both are the store's own bookkeeping — a caller states what it is changing, not how to
  // sequence it.
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
          setLoadError(failureMessage(err));
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
   * Runs one mutation's write behind whatever is already queued for its slot, so two writes to the
   * same slot reach the server in the order the user made them.
   *
   * Unslotted mutations go straight out: they claim nothing another mutation could also be
   * changing, so serializing them would only make the second one slower.
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
   * Applies `apply` to one record, runs `write`, and reconciles or rolls back only what this
   * mutation owns.
   *
   * Resolves `true` when the write landed. Callers need that: a form that clears itself on an
   * `await` returning would throw away the user's typing on every failure, because a rejected
   * write is handled here and never reaches them as a rejection.
   *
   * Three details are deliberate and easy to undo by accident.
   *
   * Ordering and staleness are the store's, keyed by {@link Mutation.slot}. They were the caller's
   * — `updateStage` built its own version counter and its own promise queue and handed the result
   * in as a predicate — which meant the store's hardest rule lived outside the store, applied to
   * exactly one of the two mutations, and was invisible to anyone reading the other.
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
            setWriteError(failureMessage(err));
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
          // record replaces it, and the `id` is prefixed so it can never be mistaken for a real one.
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
      // Unslotted for the same reason `addNote` is: this mutation owns exactly the Note carrying
      // this id, so two deletes (or a delete and an append) in flight together each find their own
      // work again.
      return mutate({
        id,
        apply: (a) => ({ ...a, notes: a.notes.filter((note) => note.id !== noteId) }),
        write: () => client.deleteNote(id, noteId),
        // Nothing to reconcile: the server's answer is the id already removed. The row is left as
        // the optimistic apply made it rather than rebuilt, so a Note appended while this write was
        // in flight is not dropped by its success.
        reconcile: (a) => a,
        // Put back where it was, into the log *as it now stands* — not by restoring `previous.notes`
        // wholesale. That would undo any Note appended while this delete was in flight, which is the
        // same field-specific-rollback rule `updateStage` follows and the loss an append-only log
        // exists to prevent. The index comes from `previous` because that is the only record of
        // where the Note sat.
        rollback: (a, previous) => {
          const index = previous.notes.findIndex((note) => note.id === noteId);
          if (index === -1 || a.notes.some((note) => note.id === noteId)) return a;

          const notes = [...a.notes];
          notes.splice(index, 0, previous.notes[index]);
          return { ...a, notes };
        },
      });
    },
    [client, mutate],
  );

  const createApplication = useCallback(
    async (payload: NewApplicationRequest): Promise<Application | null> => {
      setWriteError(null);
      try {
        const created = await client.createApplication(payload);
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
          setWriteError(failureMessage(err));
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
    createApplication,
    reload,
  };
}
