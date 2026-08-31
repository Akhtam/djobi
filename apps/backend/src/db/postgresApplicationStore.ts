/**
 * The production `ApplicationStore`: Neon Postgres through Drizzle.
 *
 * The interface it satisfies, and the in-memory adapter it is held against, are in
 * `db/applicationStore.ts`. Everything below is the half that is genuinely about Postgres —
 * jsonb parsing, the `count(*) over ()` duplicate summary, and the atomic note append — which is
 * exactly what the seam exists to keep out of the routes.
 */
import {
  ApplicationSchema,
  ApplicationStageSchema,
  type Application,
  type ApplicationSnapshot,
  type ApplicationStage,
  type ApplicationWriteResult,
  type AddApplicationNoteResult,
  type DuplicateApplicationSummary,
  type NewApplication,
  type NewNote,
  type Note,
  type UpdateApplicationStageResult,
  jobKeyForUrl,
} from '@djobi/shared';
import { desc, eq, or, sql } from 'drizzle-orm';
import type { ApplicationStore } from './applicationStore.js';
import { db } from './client.js';
import { applications } from './schema.js';

type ApplicationRow = typeof applications.$inferSelect;

/** A row in the shape {@link ApplicationSchema} expects — `createdAt` as an ISO string, not a `Date`. */
function rowShape(row: ApplicationRow) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * Parses one row, throwing if it doesn't fit.
 *
 * Parsed rather than cast, for the same reason `postgresProfileStore`'s read parses: `jobInfo`,
 * `tailoredResume` and `answers` are jsonb, so a row written before a field was added comes back
 * without it, and `row.jobInfo as JobInfo` asserted a shape the row didn't have — the compiler then
 * vouched for fields that were `undefined` at runtime. This module used to be the one place that
 * cast, which meant two policies for one hazard.
 */
function toApplication(row: ApplicationRow): Application {
  return ApplicationSchema.parse(rowShape(row));
}

/**
 * Parses every row that fits, dropping the ones that don't.
 *
 * Deliberately more forgiving than {@link toApplication}, and only for lists. A caller asking for a
 * *specific* application is owed an error if it can't be read — returning `null` would say "no such
 * application", which is a different and untrue thing. A caller listing the history is owed the
 * history, and one unreadable row from an older build should not hide every other row with it.
 */
function toApplications(rows: ApplicationRow[]): Application[] {
  return rows.flatMap((row) => {
    const parsed = ApplicationSchema.safeParse(rowShape(row));
    if (parsed.success) return [parsed.data];

    console.warn(`[djobi] skipping unreadable application ${row.id}: ${parsed.error.message}`);
    return [];
  });
}

/** Lists all stored applications, most recently created first. */
async function listApplications(): Promise<Application[]> {
  const rows = await db.select().from(applications).orderBy(desc(applications.createdAt));
  return toApplications(rows);
}

/** Reads a single application by id, or `null` if none exists with that id. */
async function getApplicationById(id: string): Promise<Application | null> {
  const [row] = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
  if (!row) return null;
  return toApplication(row);
}

/** Lists full applications for an exact job URL for legacy API consumers. */
async function listApplicationsByJobUrl(jobUrl: string): Promise<Application[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(eq(applications.jobUrl, jobUrl))
    .orderBy(desc(applications.createdAt));
  return toApplications(rows);
}

/**
 * Inserts a new application row — after the candidate explicitly saves an autofill run, or when
 * they log an application they made by hand (`source: 'manual'`).
 */
async function saveApplication(newApplication: NewApplication): Promise<ApplicationWriteResult> {
  const [row] = await db
    .insert(applications)
    .values({ ...newApplication, jobKey: jobKeyForUrl(newApplication.jobUrl) })
    .returning({ id: applications.id });
  return row;
}

/** Replaces an application's editable snapshot without disturbing interview tracking or `source`. */
async function updateApplication(
  id: string,
  snapshot: ApplicationSnapshot,
): Promise<ApplicationWriteResult | null> {
  const [row] = await db
    .update(applications)
    // Re-derived rather than left alone: the snapshot can carry a corrected `jobUrl`, and a key
    // still pointing at the old one would make the guard match a posting this row is no longer for.
    .set({ ...snapshot, jobKey: jobKeyForUrl(snapshot.jobUrl) })
    .where(eq(applications.id, id))
    .returning({ id: applications.id });
  return row ?? null;
}

/**
 * Summarizes applications to the same job posting without loading their large snapshots.
 *
 * Backs the compact duplicate guard response: the extension asks this before spending any LLM call,
 * so a posting the candidate already applied to stops the run instead of re-tailoring a resume for
 * it. The count and newest metadata come back in one database round trip.
 *
 * Matching is on `jobKey` — `jobUrl` reduced to a posting identity — rather than on the raw URL.
 * Exact-URL matching only fired when two visits produced a byte-identical URL, so a posting
 * revisited through an ad link (`?gh_src=…`, `?utm_source=…`) or from the `/apply` screen read as
 * new and cost a full re-analysis. `jobKeyForUrl` strips exactly those, and deliberately keeps
 * query parameters that do distinguish postings, so a board like Workday's `?jobId=` still
 * separates two jobs.
 *
 * The raw `jobUrl` stays in the `or` for rows written before `job_key` existed, and for a `jobUrl`
 * too malformed to derive a key from. Those match exactly as well as they did before and no better
 * — which is the point of keeping the clause rather than backfilling behind the caller's back.
 */
async function getApplicationDuplicateSummary(
  jobUrl: string,
): Promise<DuplicateApplicationSummary> {
  const jobKey = jobKeyForUrl(jobUrl);

  const [row] = await db
    .select({
      id: applications.id,
      company: applications.company,
      roleTitle: applications.roleTitle,
      stage: applications.stage,
      createdAt: applications.createdAt,
      count: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(applications)
    .where(
      jobKey === null
        ? eq(applications.jobUrl, jobUrl)
        : or(eq(applications.jobKey, jobKey), eq(applications.jobUrl, jobUrl)),
    )
    .orderBy(desc(applications.createdAt))
    .limit(1);

  if (!row) return { count: 0, latest: null };
  return {
    count: row.count,
    latest: {
      id: row.id,
      company: row.company,
      roleTitle: row.roleTitle,
      stage: ApplicationStageSchema.parse(row.stage),
      createdAt: row.createdAt.toISOString(),
    },
  };
}

/** Moves an application to a new interview stage, or `null` if no application has that id. */
async function updateApplicationStage(
  id: string,
  stage: ApplicationStage,
): Promise<UpdateApplicationStageResult | null> {
  const [row] = await db
    .update(applications)
    .set({ stage })
    .where(eq(applications.id, id))
    .returning({ id: applications.id, stage: applications.stage });

  return row ? { id: row.id, stage: ApplicationStageSchema.parse(row.stage) } : null;
}

/**
 * Appends one note to an application's log, or `null` if no application has that id.
 *
 * `id` and `createdAt` are generated here, never taken from the caller — a note whose timestamp the
 * sender chose isn't trustworthy history, which is the rule `NoteSchema` states and this is where
 * it has to be enforced.
 *
 * The append is a single `notes || …` statement rather than a read, a push and a write. Two notes
 * added close together — the dashboard open in two tabs, or a double-submitted form — both read the
 * same array under read-modify-write and the second write silently discards the first. That is
 * exactly the loss an append-only log exists to prevent, so the concatenation happens in Postgres
 * where it is atomic.
 */
async function addApplicationNote(
  id: string,
  note: NewNote,
): Promise<AddApplicationNoteResult | null> {
  const appended: Note = {
    ...note,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const [row] = await db
    .update(applications)
    .set({ notes: sql`${applications.notes} || ${JSON.stringify([appended])}::jsonb` })
    .where(eq(applications.id, id))
    .returning({ id: applications.id });

  return row ? { id: row.id, note: appended } : null;
}

/**
 * The routes' view of the eight operations above, under the names `ApplicationStore` states.
 *
 * Written as one object rather than eight exports because the seam is the point: a route holding
 * eight loose imports can only be run without Postgres by replacing this module, which is what four
 * test files used to do by hand.
 */
export const postgresApplicationStore: ApplicationStore = {
  list: listApplications,
  byId: getApplicationById,
  byJobUrl: listApplicationsByJobUrl,
  duplicateSummary: getApplicationDuplicateSummary,
  create: saveApplication,
  replaceSnapshot: updateApplication,
  setStage: updateApplicationStage,
  appendNote: addApplicationNote,
};
