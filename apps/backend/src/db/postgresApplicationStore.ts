/**
 * The production `ApplicationStore` (interface and in-memory twin in `applicationStore.ts`): jsonb
 * parsing, the duplicate summary and atomic note edits.
 */
import {
  ApplicationSchema,
  ApplicationStageSchema,
  type Application,
  type ApplicationSnapshot,
  type ApplicationStage,
  type ApplicationWriteResult,
  type AddApplicationNoteResult,
  type DeleteApplicationNoteResult,
  type DeleteApplicationResult,
  type DuplicateApplicationSummary,
  type NewApplication,
  type NewNote,
  type Note,
  type UpdateApplicationStageResult,
  jobKeyForUrl,
} from '@djobi/shared';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { ApplicationStore, Written } from './applicationStore.js';
import { db } from './client.js';
import { applications } from './schema.js';

type ApplicationRow = typeof applications.$inferSelect;

/**
 * A row in the shape {@link ApplicationSchema} expects — `createdAt` as an ISO string, not a
 * `Date`.
 */
function rowShape(row: ApplicationRow) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * Parses one row, throwing if it doesn't fit — jsonb columns may predate schema fields, so rows are
 * parsed, never cast. `userId` is dropped by the parse (it isn't part of `ApplicationSchema`).
 */
function toApplication(row: ApplicationRow): Application {
  return ApplicationSchema.parse(rowShape(row));
}

/**
 * Parses every row that fits and drops the rest: one unreadable legacy row shouldn't hide the
 * history. (A single-row read throws instead — `null` would wrongly mean "not found".)
 */
function toApplications(rows: ApplicationRow[]): Application[] {
  return rows.flatMap((row) => {
    const parsed = ApplicationSchema.safeParse(rowShape(row));
    if (parsed.success) return [parsed.data];

    console.warn(`[djobi] skipping unreadable application ${row.id}: ${parsed.error.message}`);
    return [];
  });
}

/**
 * A write's returned row, or `null` if unreadable — the write already landed, so reading it back
 * mustn't fail it (see {@link Written}).
 */
function toWrittenApplication(row: ApplicationRow): Application | null {
  const parsed = ApplicationSchema.safeParse(rowShape(row));
  if (parsed.success) return parsed.data;

  console.warn(
    `[djobi] wrote application ${row.id} but could not read it back: ${parsed.error.message}`,
  );
  return null;
}

/** Lists `userId`'s stored applications, most recently created first. */
async function listApplications(userId: string): Promise<Application[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.createdAt));
  return toApplications(rows);
}

/**
 * One Application by id, scoped to `userId` in the `WHERE` — another user's row is
 * indistinguishable from a missing one.
 */
async function getApplicationById(userId: string, id: string): Promise<Application | null> {
  const [row] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .limit(1);
  if (!row) return null;
  return toApplication(row);
}

/** Lists `userId`'s full applications for an exact job URL, for legacy API consumers. */
async function listApplicationsByJobUrl(userId: string, jobUrl: string): Promise<Application[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(and(eq(applications.userId, userId), eq(applications.jobUrl, jobUrl)))
    .orderBy(desc(applications.createdAt));
  return toApplications(rows);
}

/**
 * Inserts an Application owned by `userId`. With `idempotencyKey`, `ON CONFLICT` returns the row a
 * previous attempt already wrote (the `set` is a no-op for `RETURNING`'s sake). Keyless inserts
 * never conflict: unique indexes treat `NULL`s as distinct.
 */
async function saveApplication(
  userId: string,
  newApplication: NewApplication,
  idempotencyKey?: string,
): Promise<Written<ApplicationWriteResult>> {
  // Every column, not just `id`: `RETURNING *` costs the same round trip as `RETURNING id`, and it
  // is what spares the route a second query when the caller wants the row back. Same below.
  const [row] = await db
    .insert(applications)
    .values({
      ...newApplication,
      userId,
      jobKey: jobKeyForUrl(newApplication.jobUrl),
      idempotencyKey: idempotencyKey || null,
    })
    .onConflictDoUpdate({
      target: [applications.userId, applications.idempotencyKey],
      set: { id: sql`${applications.id}` },
    })
    .returning();
  // An upsert with `RETURNING` always yields the inserted or conflicting row.
  if (!row) throw new Error('saveApplication: INSERT … RETURNING produced no row');
  return { id: row.id, application: toWrittenApplication(row) };
}

/**
 * Replaces the editable snapshot, leaving tracking and `source` alone. `null` if not this user's.
 */
async function updateApplication(
  userId: string,
  id: string,
  snapshot: ApplicationSnapshot,
): Promise<Written<ApplicationWriteResult> | null> {
  const [row] = await db
    .update(applications)
    // Re-derived rather than left alone: the snapshot can carry a corrected `jobUrl`, and a key
    // still pointing at the old one would make the guard match a posting this row is no longer for.
    .set({ ...snapshot, jobKey: jobKeyForUrl(snapshot.jobUrl) })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .returning();
  if (!row) return null;
  return { id: row.id, application: toWrittenApplication(row) };
}

/**
 * Count and newest metadata of `userId`'s Applications for one posting, in one round trip and
 * without loading snapshots — the Duplicate Guard's lookup.
 *
 * Matches `job_key` (so ad-link params and `/apply` routes don't read as new), or exact `job_url`
 * for rows with `job_key IS NULL` (legacy rows, unparseable URLs). The `userId` filter wraps the
 * whole `or` — getting that wrong would leak one user's history to another.
 */
async function getApplicationDuplicateSummary(
  userId: string,
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
      and(
        eq(applications.userId, userId),
        jobKey === null
          ? eq(applications.jobUrl, jobUrl)
          : or(
              eq(applications.jobKey, jobKey),
              and(isNull(applications.jobKey), eq(applications.jobUrl, jobUrl)),
            ),
      ),
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

/** Moves an Application to a new stage, or `null` if `userId` has no such row. */
async function updateApplicationStage(
  userId: string,
  id: string,
  stage: ApplicationStage,
): Promise<Written<UpdateApplicationStageResult> | null> {
  const [row] = await db
    .update(applications)
    .set({ stage })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .returning();

  if (!row) return null;
  return {
    id: row.id,
    // Still parsed off the column rather than taken from the argument: the authoritative Stage is
    // the one Postgres now holds, which is the whole point of answering with it.
    stage: ApplicationStageSchema.parse(row.stage),
    application: toWrittenApplication(row),
  };
}

/**
 * Appends one note, or `null` if `userId` has no such row. `id`/`createdAt` are generated here.
 * A single `notes || …` statement, so concurrent appends (two tabs, a double submit) can't lose
 * each other.
 */
async function addApplicationNote(
  userId: string,
  id: string,
  note: NewNote,
): Promise<Written<AddApplicationNoteResult> | null> {
  const appended: Note = {
    ...note,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const [row] = await db
    .update(applications)
    .set({ notes: sql`${applications.notes} || ${JSON.stringify([appended])}::jsonb` })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .returning();

  if (!row) return null;
  return { id: row.id, note: appended, application: toWrittenApplication(row) };
}

/**
 * Removes one note in a single statement (so a concurrent append isn't overwritten), or `null` if
 * the row or the note doesn't exist — the `exists` check is what distinguishes those from success.
 * `coalesce(…, '[]')` because `jsonb_agg` over no rows is `NULL`.
 */
async function deleteApplicationNote(
  userId: string,
  id: string,
  noteId: string,
): Promise<Written<DeleteApplicationNoteResult> | null> {
  const [row] = await db
    .update(applications)
    .set({
      notes: sql`(
        select coalesce(jsonb_agg(note), '[]'::jsonb)
        from jsonb_array_elements(${applications.notes}) as note
        where note->>'id' is distinct from ${noteId}
      )`,
    })
    .where(
      and(
        eq(applications.id, id),
        eq(applications.userId, userId),
        sql`exists (
          select 1 from jsonb_array_elements(${applications.notes}) as note
          where note->>'id' = ${noteId}
        )`,
      ),
    )
    .returning();

  if (!row) return null;
  return { id: row.id, noteId, application: toWrittenApplication(row) };
}

/** Deletes one Application scoped to `(id, userId)`; `null` if there was none. */
async function deleteApplication(
  userId: string,
  id: string,
): Promise<DeleteApplicationResult | null> {
  const [row] = await db
    .delete(applications)
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .returning({ id: applications.id });

  return row ?? null;
}

/** The operations above as the `ApplicationStore` port. */
export const postgresApplicationStore: ApplicationStore = {
  list: listApplications,
  byId: getApplicationById,
  byJobUrl: listApplicationsByJobUrl,
  duplicateSummary: getApplicationDuplicateSummary,
  create: saveApplication,
  replaceSnapshot: updateApplication,
  setStage: updateApplicationStage,
  appendNote: addApplicationNote,
  deleteNote: deleteApplicationNote,
  deleteApplication,
};
