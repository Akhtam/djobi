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
 * adapter that disagrees with Postgres about ordering, duplicate matching or what a write leaves
 * alone is worse than no adapter at all, because every route test then passes against behaviour
 * production does not have.
 */
import {
  jobKeyForUrl,
  type AddApplicationNoteResult,
  type Application,
  type ApplicationSnapshot,
  type ApplicationStage,
  type ApplicationWriteResult,
  type DuplicateApplicationSummary,
  type NewApplication,
  type NewNote,
  type Note,
  type UpdateApplicationStageResult,
} from '@djobi/shared';

/**
 * Everything the backend needs from Application persistence.
 *
 * The write methods answer with a compact acknowledgement (`{ id }`, or the field they changed)
 * rather than the full row, and `null` rather than throwing when no row has that id — "no such
 * application" is a 404 the route already knows how to answer, not a fault. `routes/applications.ts`
 * reads the row back itself when a caller wants one.
 */
export interface ApplicationStore {
  /** Every stored Application, most recently created first. */
  list(): Promise<Application[]>;
  /** One Application, or `null` when no row has that id. */
  byId(id: string): Promise<Application | null>;
  /** Applications whose `jobUrl` matches exactly — the legacy full-row lookup. */
  byJobUrl(jobUrl: string): Promise<Application[]>;
  /**
   * The Duplicate Guard's compact answer for a posting: how many Applications share it, and the
   * newest one's tracking metadata. Matches on Job Key, falling back to an exact `jobUrl` for rows
   * that have none — see the Postgres adapter for why the fallback stays.
   */
  duplicateSummary(jobUrl: string): Promise<DuplicateApplicationSummary>;
  /** Inserts a new Application, assigning its id and `createdAt`. */
  create(application: NewApplication): Promise<ApplicationWriteResult>;
  /**
   * Replaces an Application's editable snapshot, leaving Stage, Notes and Application Source
   * untouched. `null` when no row has that id.
   */
  replaceSnapshot(
    id: string,
    snapshot: ApplicationSnapshot,
  ): Promise<ApplicationWriteResult | null>;
  /** Moves an Application to a Stage, answering with the authoritative value. `null` when missing. */
  setStage(id: string, stage: ApplicationStage): Promise<UpdateApplicationStageResult | null>;
  /**
   * Appends one Note, assigning its id and `createdAt` here rather than taking them from the
   * caller. `null` when no row has that id.
   */
  appendNote(id: string, note: NewNote): Promise<AddApplicationNoteResult | null>;
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
 * Newest-first ordering is by `createdAt` descending, tie-broken by insertion order so two rows
 * written inside the same millisecond still come back in a defined order. Postgres breaks that tie
 * arbitrarily, which is why the contract suite asserts ordering only across distinct timestamps —
 * a fake that promised more than the real adapter delivers would let a route test rely on it.
 */
export function inMemoryApplicationStore(seed: Application[] = []): ApplicationStore {
  const rows = new Map<string, Application>();
  // Insertion sequence per id, purely for the tie-break above.
  const sequence = new Map<string, number>();
  let nextSequence = 0;

  function put(application: Application): void {
    rows.set(application.id, application);
    sequence.set(application.id, nextSequence++);
  }

  for (const application of seed) put(application);

  function newestFirst(candidates: Application[]): Application[] {
    return [...candidates].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return (sequence.get(b.id) ?? 0) - (sequence.get(a.id) ?? 0);
    });
  }

  return {
    async list() {
      return newestFirst([...rows.values()]);
    },

    async byId(id) {
      return rows.get(id) ?? null;
    },

    async byJobUrl(jobUrl) {
      return newestFirst([...rows.values()].filter((row) => row.jobUrl === jobUrl));
    },

    async duplicateSummary(jobUrl) {
      const jobKey = jobKeyForUrl(jobUrl);
      const matches = newestFirst(
        [...rows.values()].filter((row) => samePosting(row, jobUrl, jobKey)),
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

    async create(application) {
      const id = crypto.randomUUID();
      put({ ...application, id, createdAt: new Date().toISOString() });
      return { id };
    },

    async replaceSnapshot(id, snapshot) {
      const existing = rows.get(id);
      if (!existing) return null;

      // Spread the snapshot over the row rather than replacing it: `source`, `stage`, `notes`,
      // `id` and `createdAt` are not the snapshot's to write, which is what `ApplicationSnapshot`
      // omitting them says and what the Postgres adapter's partial `set` does.
      rows.set(id, { ...existing, ...snapshot });
      return { id };
    },

    async setStage(id, stage) {
      const existing = rows.get(id);
      if (!existing) return null;

      rows.set(id, { ...existing, stage });
      return { id, stage };
    },

    async appendNote(id, note) {
      const existing = rows.get(id);
      if (!existing) return null;

      const appended: Note = {
        ...note,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      rows.set(id, { ...existing, notes: [...existing.notes, appended] });
      return { id, note: appended };
    },
  };
}
