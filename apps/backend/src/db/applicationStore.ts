/**
 * The backend's view of where Applications are persisted, and the in-memory adapter its tests run
 * against.
 *
 * Two implementations sit behind one interface, exactly as `BackendClient` / `httpBackendClient` do
 * in `apps/extension/src/lib/backendClient.ts` and `DashboardClient` / `httpDashboardClient` do in
 * the dashboard, for the same reason: it turns the persistence seam into something a test can
 * substitute, so every route is exercised end to end with no database.
 *
 * It replaces module mocking. `routes/applications.ts` imported eight loose functions from
 * `postgresApplicationStore.ts`, so the only way to run a route without Postgres was to replace that
 * module — which four test files did, each restating the full export surface by hand, and one of
 * them commented that an incomplete factory is "a time bomb" (it is: Vitest replaces the whole
 * module, so a name the factory omits fails at import time inside the route rather than in the
 * test). A missing method is now a compile error in the adapter that lacks it.
 *
 * `inMemoryApplicationStore` is for tests only and is deliberately not wired into `index.ts`, the
 * same judgement `createFixtureDashboardClient` records: a runtime flag that swaps the real database
 * for memory is a flag that can be left on, and an app that looks like it is saving while writing to
 * a `Map` is worse than one that visibly cannot reach its database.
 *
 * The two adapters are held to one another by `applicationStore.contract.test.ts`, which runs the
 * same suite against both — the in-memory one and a real Postgres (PGlite) one. An in-memory
 * adapter that disagrees with Postgres about ordering, duplicate matching, what a write leaves
 * alone, or user scoping is worse than no adapter at all, because every route test then passes
 * against behaviour production does not have.
 */
import {
  jobKeyForUrl,
  type AddApplicationNoteResult,
  type Application,
  type ApplicationSnapshot,
  type ApplicationStage,
  type ApplicationWriteResult,
  type DeleteApplicationNoteResult,
  type DeleteApplicationResult,
  type DuplicateApplicationSummary,
  type NewApplication,
  type NewNote,
  type Note,
  type UpdateApplicationStageResult,
} from '@djobi/shared';

/**
 * A write's answer: the compact acknowledgement, plus the row it left behind.
 *
 * The compact half (`{ id }`, or the field the write changed) is what goes on the wire to a caller
 * that asked for `response=compact`, and is `null` rather than a throw when no row has that id —
 * "no such application" is a 404 the route already knows how to answer, not a fault.
 *
 * `application` is the same row a follow-up `byId` would have returned, carried back from the write
 * itself. It exists so `routes/applications.ts` can answer a full-row write without a second query:
 * this backend talks to Neon over HTTP (see `db/client.ts`), so every store call is its own network
 * round trip, and reading back what the write just returned paid for two of them. Postgres answers
 * writes with `RETURNING` at no extra cost, so the row is already in hand.
 *
 * It is `null` only when the stored row cannot be parsed into an `Application` — a row written by an
 * older build whose jsonb predates a required field. Compact callers are unaffected by that (they
 * never wanted the row), which is why this is nullable rather than a throw: making every
 * `PATCH …/stage` parse a snapshot it isn't returning would turn a legacy row into a failed write.
 * The route falls back to `byId` for the full-row case, so an unreadable row still reports itself
 * exactly as it did before.
 */
export type Written<Result> = Result & { application: Application | null };

/**
 * Everything the backend needs from Application persistence.
 *
 * Every method takes `userId` first (`docs/multi-tenant-auth.md`, Phase A). A row belonging to a
 * different user must be exactly as unreachable as one that doesn't exist — `byId` and the four
 * writes below answer `null` for either case, on purpose: a 403 would confirm the id is real and
 * leak its existence, so "not yours" and "not there" stay indistinguishable on the wire.
 */
export interface ApplicationStore {
  /** Every Application `userId` owns, most recently created first. */
  list(userId: string): Promise<Application[]>;
  /** One Application, or `null` when no row has that id *for this user*. */
  byId(userId: string, id: string): Promise<Application | null>;
  /** `userId`'s Applications whose `jobUrl` matches exactly — the legacy full-row lookup. */
  byJobUrl(userId: string, jobUrl: string): Promise<Application[]>;
  /**
   * The Duplicate Guard's compact answer for a posting, scoped to `userId`: how many of *their*
   * Applications share it, and the newest one's tracking metadata. Matches on Job Key, falling back
   * to an exact `jobUrl` for rows that have none — see the Postgres adapter for why the fallback
   * stays. Never counts another user's row: an unscoped guard would tell one candidate they already
   * applied to a posting only someone else has ever seen.
   */
  duplicateSummary(userId: string, jobUrl: string): Promise<DuplicateApplicationSummary>;
  /**
   * Inserts a new Application owned by `userId`, assigning its id and `createdAt`.
   *
   * `idempotencyKey`, when given, makes a resend safe: a second `create` for the same `userId` and
   * key returns the row the first call already wrote instead of inserting a duplicate. It exists
   * because a client cannot tell "the write failed" from "the write succeeded and the response was
   * lost" — a timeout, a dropped connection — and an unconditional retry after either looks
   * identical from here. Omitted, `create` always inserts, exactly as it did before this existed.
   */
  create(
    userId: string,
    application: NewApplication,
    idempotencyKey?: string,
  ): Promise<Written<ApplicationWriteResult>>;
  /**
   * Replaces an Application's editable snapshot, leaving Stage, Notes and Application Source
   * untouched. `null` when no row has that id for this user.
   */
  replaceSnapshot(
    userId: string,
    id: string,
    snapshot: ApplicationSnapshot,
  ): Promise<Written<ApplicationWriteResult> | null>;
  /** Moves an Application to a Stage, answering with the authoritative value. `null` when missing. */
  setStage(
    userId: string,
    id: string,
    stage: ApplicationStage,
  ): Promise<Written<UpdateApplicationStageResult> | null>;
  /**
   * Appends one Note, assigning its id and `createdAt` here rather than taking them from the
   * caller. `null` when no row has that id for this user.
   */
  appendNote(
    userId: string,
    id: string,
    note: NewNote,
  ): Promise<Written<AddApplicationNoteResult> | null>;
  /**
   * Removes one Note from an Application's log. `null` when this user has no such application
   * **or** when the row has no note with that id.
   *
   * The two are one answer on purpose, and it is the same reasoning as the ownership rule above:
   * both mean "there is nothing here to delete", and both are the 404 the route already knows how
   * to write. Reporting a delete that deleted nothing as a success is the failure worth avoiding —
   * a client would clear the note from its own view and be wrong about the record.
   */
  deleteNote(
    userId: string,
    id: string,
    noteId: string,
  ): Promise<Written<DeleteApplicationNoteResult> | null>;
  /**
   * Removes an Application entirely. `null` when this user has no such row — the same
   * indistinguishable "not yours or not there" as every other method here.
   *
   * Unlike every write above, there is no row left to carry back — nothing to spread into
   * `Written`, so this answers the bare compact result on success.
   */
  deleteApplication(userId: string, id: string): Promise<DeleteApplicationResult | null>;
}

/**
 * Whether `candidate` is an Application for the same posting as `jobUrl`.
 *
 * The rule the Postgres adapter writes as a `WHERE job_key = … OR job_url = …`, stated once here so
 * the two adapters cannot disagree about what "the same posting" means. Both halves matter: the Job
 * Key is what makes a posting revisited through an ad link match, and the raw `jobUrl` is what still
 * finds a row written before Job Keys existed.
 */
function samePosting(candidate: Application, jobUrl: string, jobKey: string | null): boolean {
  if (candidate.jobUrl === jobUrl) return true;
  return jobKey !== null && jobKeyForUrl(candidate.jobUrl) === jobKey;
}

/**
 * An `ApplicationStore` held in a `Map`, for tests.
 *
 * Its writes always carry back a parsed `application` (see {@link Written}) — it holds parsed
 * Applications, so it has no unreadable-row case to report. Postgres does, which is why the field is
 * nullable in the interface and why the route keeps a fallback this adapter never exercises.
 *
 * Newest-first ordering is by `createdAt` descending, tie-broken by insertion order so two rows
 * written inside the same millisecond still come back in a defined order. Postgres breaks that tie
 * arbitrarily, which is why the contract suite asserts ordering only across distinct timestamps —
 * a fake that promised more than the real adapter delivers would let a route test rely on it.
 *
 * `Application` itself carries no `userId` field — that stays a persistence detail, never part of
 * the wire type (see `docs/multi-tenant-auth.md`'s note on why `ApplicationSchema` is untouched) —
 * so ownership is tracked in a parallel `owners` map rather than on the stored row.
 */
export function inMemoryApplicationStore(
  seed: { userId: string; application: Application }[] = [],
): ApplicationStore {
  const rows = new Map<string, Application>();
  const owners = new Map<string, string>();
  // Insertion sequence per id, purely for the tie-break above.
  const sequence = new Map<string, number>();
  let nextSequence = 0;
  // `userId` and the key together, matching the Postgres adapter's `(user_id, idempotency_key)`
  // unique index — two different candidates may pick the same client-generated key without
  // colliding.
  const idempotencyKeys = new Map<string, string>();

  function put(userId: string, application: Application): void {
    rows.set(application.id, application);
    owners.set(application.id, userId);
    sequence.set(application.id, nextSequence++);
  }

  for (const { userId, application } of seed) put(userId, application);

  function newestFirst(candidates: Application[]): Application[] {
    return [...candidates].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return (sequence.get(b.id) ?? 0) - (sequence.get(a.id) ?? 0);
    });
  }

  function ownedRows(userId: string): Application[] {
    return [...rows.values()].filter((row) => owners.get(row.id) === userId);
  }

  /** `null` for a real row this user doesn't own — indistinguishable from a row that never existed. */
  function ownedRow(userId: string, id: string): Application | null {
    if (owners.get(id) !== userId) return null;
    return rows.get(id) ?? null;
  }

  return {
    async list(userId) {
      return newestFirst(ownedRows(userId));
    },

    async byId(userId, id) {
      return ownedRow(userId, id);
    },

    async byJobUrl(userId, jobUrl) {
      return newestFirst(ownedRows(userId).filter((row) => row.jobUrl === jobUrl));
    },

    async duplicateSummary(userId, jobUrl) {
      const jobKey = jobKeyForUrl(jobUrl);
      const matches = newestFirst(
        ownedRows(userId).filter((row) => samePosting(row, jobUrl, jobKey)),
      );

      const [newest] = matches;
      if (!newest) return { count: 0, latest: null };

      return {
        count: matches.length,
        latest: {
          id: newest.id,
          company: newest.company,
          roleTitle: newest.roleTitle,
          stage: newest.stage,
          createdAt: newest.createdAt,
        },
      };
    },

    async create(userId, application, idempotencyKey) {
      if (idempotencyKey) {
        const dedupeKey = `${userId} ${idempotencyKey}`;
        const existingId = idempotencyKeys.get(dedupeKey);
        const existing = existingId ? rows.get(existingId) : undefined;
        if (existing) return { id: existing.id, application: existing };
      }

      const id = crypto.randomUUID();
      const created: Application = { ...application, id, createdAt: new Date().toISOString() };
      put(userId, created);
      if (idempotencyKey) idempotencyKeys.set(`${userId} ${idempotencyKey}`, id);
      return { id, application: created };
    },

    async replaceSnapshot(userId, id, snapshot) {
      const existing = ownedRow(userId, id);
      if (!existing) return null;

      // Spread the snapshot over the row rather than replacing it: `source`, `stage`, `notes`,
      // `id` and `createdAt` are not the snapshot's to write, which is what `ApplicationSnapshot`
      // omitting them says and what the Postgres adapter's partial `set` does.
      const replaced: Application = { ...existing, ...snapshot };
      rows.set(id, replaced);
      return { id, application: replaced };
    },

    async setStage(userId, id, stage) {
      const existing = ownedRow(userId, id);
      if (!existing) return null;

      const staged: Application = { ...existing, stage };
      rows.set(id, staged);
      return { id, stage, application: staged };
    },

    async appendNote(userId, id, note) {
      const existing = ownedRow(userId, id);
      if (!existing) return null;

      const appended: Note = {
        ...note,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      const annotated: Application = { ...existing, notes: [...existing.notes, appended] };
      rows.set(id, annotated);
      return { id, note: appended, application: annotated };
    },

    async deleteNote(userId, id, noteId) {
      const existing = ownedRow(userId, id);
      if (!existing) return null;

      const remaining = existing.notes.filter((note) => note.id !== noteId);
      // Length, not a lookup, for the same reason the Postgres adapter compares lengths: it is the
      // one check that cannot disagree with what the filter actually did.
      if (remaining.length === existing.notes.length) return null;

      const trimmed: Application = { ...existing, notes: remaining };
      rows.set(id, trimmed);
      return { id, noteId, application: trimmed };
    },

    async deleteApplication(userId, id) {
      if (!ownedRow(userId, id)) return null;

      rows.delete(id);
      owners.delete(id);
      sequence.delete(id);
      return { id };
    },
  };
}
