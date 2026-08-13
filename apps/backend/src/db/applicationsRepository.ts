import {
  ApplicationSchema,
  type Application,
  type ApplicationStage,
  type NewApplication,
  type NewNote,
  type Note,
} from '@djobi/shared';
import { desc, eq } from 'drizzle-orm';
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

/** Inserts a new application row after an autofill completes. */
export async function saveApplication(newApplication: NewApplication): Promise<Application> {
  const [row] = await db.insert(applications).values(newApplication).returning();
  return toApplication(row);
}

/** Lists past applications to the given company, most recently created first. */
export async function listApplicationsByCompany(company: string): Promise<Application[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(eq(applications.company, company))
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
