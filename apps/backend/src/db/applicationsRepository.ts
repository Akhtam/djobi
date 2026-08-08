import type { Application, NewApplication } from '@djobi/shared';
import { desc, eq } from 'drizzle-orm';
import { db } from './client.js';
import { applications } from './schema.js';

function toApplication(row: typeof applications.$inferSelect): Application {
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.roleTitle,
    jobUrl: row.jobUrl,
    jobInfo: row.jobInfo as Application['jobInfo'],
    tailoredResume: row.tailoredResume as Application['tailoredResume'],
    answers: row.answers as Application['answers'],
    status: row.status as Application['status'],
    createdAt: row.createdAt.toISOString(),
  };
}

/** Lists all stored applications, most recently created first. */
export async function listApplications(): Promise<Application[]> {
  const rows = await db.select().from(applications).orderBy(desc(applications.createdAt));
  return rows.map(toApplication);
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
  return rows.map(toApplication);
}
