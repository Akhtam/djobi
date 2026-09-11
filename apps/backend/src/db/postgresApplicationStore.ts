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
  type DeleteApplicationNoteResult,
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
 *
 * `row.userId` never reaches this parse: `ApplicationSchema` (`@djobi/shared`) has no such field —
 * ownership stays a persistence detail, not part of the wire type — and zod's default non-strict
 * `.parse()` silently drops any key the schema doesn't declare.
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

/**
 * The row a write returned, parsed if it can be — see {@link Written} for why an unreadable one is
 * `null` here rather than a throw.
 *
 * Distinct from {@link toApplication}, which throws, and from {@link toApplications}, which drops:
 * a write's caller may not have asked for the row at all, so failing to read it back must not fail
 * the write that already landed.
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
 * Reads a single application by id, scoped to `userId`.
 *
 * `null` both when no row has that id at all, and when one does but belongs to a different user —
 * the two cases must answer identically, or a 403-shaped response would confirm a real id exists
 * under someone else's account. `and()` in the `WHERE`, not a second check after the query, is what
 * makes that true at the SQL level rather than by remembering to compare afterward.
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
 * Inserts a new application row owned by `userId` — after the candidate explicitly saves an autofill
 * run, or when they log an application they made by hand (`source: 'manual'`).
 *
 * `idempotencyKey` is what makes a resend safe. A caller that retries a timed-out or lost-response
 * write sends the same key it sent the first time; if that first write actually landed, the
 * `ON CONFLICT` below hands back the row it already wrote instead of inserting a second one. The
 * `set` is a deliberate no-op — only its `RETURNING` is wanted — and a caller with no key to give
 * always inserts, because a Postgres unique index never treats two `NULL`s as conflicting.
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
  return { id: row.id, application: toWrittenApplication(row) };
}

/**
 * Replaces an application's editable snapshot without disturbing interview tracking or `source` —
 * only if `userId` owns the row; otherwise `null`, same as if it didn't exist.
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
 * Summarizes `userId`'s applications to the same job posting without loading their large snapshots.
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
 *
 * That fallback is narrowed to `job_key IS NULL` rather than left as a bare `job_url = …`. A row
 * that *has* a key is already matched by the first clause whenever its URL matches, since the key is
 * derived from the URL — so the unqualified version only made Postgres scan the `job_url` index for
 * rows the `job_key` index had found already. Keying the fallback to the rows that are actually
 * missing a key says the same thing about which rows match, and asks for less to say it.
 *
 * The `userId` filter is `and`-ed around the whole `job_key`-or-`job_url` clause, not appended after
 * it — this is the one query in the file where getting that wrong would be a real leak, not just an
 * inefficiency: it is exactly what stops one user's saved application from telling a different user
 * they already applied to a posting they've never seen.
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

/**
 * Moves an application to a new interview stage, or `null` if `userId` has no application with that
 * id.
 */
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
 * Appends one note to an application's log, or `null` if `userId` has no application with that id.
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
 * Removes one note from an application's log, or `null` when this user has no application with that
 * id **or** that application has no note with that id.
 *
 * One statement, for the same reason {@link addApplicationNote} is one: a read, a filter and a
 * write let a note appended between the read and the write come back from the dead, which is the
 * mirror image of the loss the append exists to prevent. Postgres rebuilds the array with
 * `jsonb_agg` over the elements that survive the filter, so nothing outside this note is rewritten
 * from a stale copy.
 *
 * `coalesce(…, '[]')` is load-bearing: `jsonb_agg` over zero surviving rows is `NULL`, not an empty
 * array, so deleting the only note would otherwise write `NULL` into a `NOT NULL` column — and on a
 * nullable one it would produce a row that no longer parses as an Application.
 *
 * The `exists` in the `WHERE` is what makes "deleted" and "there was nothing to delete"
 * distinguishable. Without it the update matches the row, changes nothing, and `RETURNING` hands
 * back a perfectly good row — so a client asking to delete a note that another tab already deleted
 * would be told it succeeded.
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

/**
 * The routes' view of the nine operations above, under the names `ApplicationStore` states.
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
  deleteNote: deleteApplicationNote,
};
