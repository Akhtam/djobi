import {
  ApplicationSchema,
  type Application,
  type ApplicationSnapshot,
  type ApplicationStage,
  type NewApplication,
  type NewNote,
  type Note,
} from '@djobi/shared';
import { desc, eq, sql } from 'drizzle-orm';
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
 * Parsed rather than cast, for the same reason `profileRepository.getProfile` parses: `jobInfo`,
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
export async function listApplications(): Promise<Application[]> {
  const rows = await db.select().from(applications).orderBy(desc(applications.createdAt));
  return toApplications(rows);
}

/** Reads a single application by id, or `null` if none exists with that id. */
export async function getApplicationById(id: string): Promise<Application | null> {
  const [row] = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
  if (!row) return null;
  return toApplication(row);
}

/**
 * Inserts a new application row — after the candidate explicitly saves an autofill run, or when
 * they log an application they made by hand (`source: 'manual'`).
 */
export async function saveApplication(newApplication: NewApplication): Promise<Application> {
  const [row] = await db.insert(applications).values(newApplication).returning();
  return toApplication(row);
}

/** Replaces an application's editable snapshot without disturbing interview tracking or `source`. */
export async function updateApplication(
  id: string,
  snapshot: ApplicationSnapshot,
): Promise<Application | null> {
  const [row] = await db
    .update(applications)
    .set(snapshot)
    .where(eq(applications.id, id))
    .returning();
  return row ? toApplication(row) : null;
}

/**
 * One past application to a company, reduced to what a history summary needs.
 *
 * A projection rather than an `Application` because the only caller
 * (`buildPriorApplicationsSummary` in `routes/tailor-resume.ts`) builds `"<role> (<date>)"` lines
 * and reads nothing else. Selecting whole rows meant every past application at that company shipped
 * its `jobInfo`, `tailoredResume`, `answers` and `notes` jsonb across the wire, on the Analyze path,
 * to be discarded — and each one had to survive `ApplicationSchema.parse` to be counted, so a row
 * written by an older build dropped out of a summary that only ever needed two of its columns.
 */
export interface PriorApplication {
  roleTitle: string;
  createdAt: string;
}

/** Lists past applications to the given company, most recently created first. */
export async function listPriorApplicationsByCompany(company: string): Promise<PriorApplication[]> {
  const rows = await db
    .select({ roleTitle: applications.roleTitle, createdAt: applications.createdAt })
    .from(applications)
    .where(eq(applications.company, company))
    .orderBy(desc(applications.createdAt));

  return rows.map((row) => ({ roleTitle: row.roleTitle, createdAt: row.createdAt.toISOString() }));
}

/**
 * Lists past applications to the exact same job URL, most recently created first.
 *
 * Backs the duplicate guard on Analyze: the extension asks this before spending any LLM call, so a
 * posting the candidate already applied to stops the run instead of re-tailoring a resume for it.
 * Matched exactly rather than normalized — a query string can be what distinguishes two postings on
 * the same board, so stripping one risks suppressing an application the candidate hasn't made.
 */
export async function listApplicationsByJobUrl(jobUrl: string): Promise<Application[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(eq(applications.jobUrl, jobUrl))
    .orderBy(desc(applications.createdAt));
  return toApplications(rows);
}

/** Moves an application to a new interview stage, or `null` if no application has that id. */
export async function updateApplicationStage(
  id: string,
  stage: ApplicationStage,
): Promise<Application | null> {
  const [row] = await db
    .update(applications)
    .set({ stage })
    .where(eq(applications.id, id))
    .returning();

  return row ? toApplication(row) : null;
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
export async function addApplicationNote(id: string, note: NewNote): Promise<Application | null> {
  const appended: Note = {
    ...note,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const [row] = await db
    .update(applications)
    .set({ notes: sql`${applications.notes} || ${JSON.stringify([appended])}::jsonb` })
    .where(eq(applications.id, id))
    .returning();

  return row ? toApplication(row) : null;
}
