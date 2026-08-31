import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The base profile, stored whole. `data` holds a `Profile` object (from `@djobi/shared`) as
 * jsonb — no migration is needed when the `Profile` shape changes, since Drizzle just reads/writes
 * whatever is in the column.
 */
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per job applied to — autofilled by the extension, or logged by hand afterwards (see
 * `source`). `company`/`roleTitle`/`jobUrl`/`jobKey` are plain columns
 * so they stay queryable without reaching into JSON; `jobInfo`/`tailoredResume`/`answers` are
 * jsonb snapshots (of `JobInfo`/`TailoredResume`/`QuestionAnswer[]` from `@djobi/shared`) so a past
 * application remains readable even if the schema or tailoring prompt changes later.
 */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    company: text('company').notNull(),
    roleTitle: text('role_title').notNull(),
    jobUrl: text('job_url').notNull(),
    /**
     * `jobUrl` reduced to a posting identity by `jobKeyForUrl` — the Duplicate Guard's real match
     * column. Derived in `postgresApplicationStore`, never accepted from a client: a key the caller
     * chose would let two different postings collide.
     *
     * Nullable because rows written before this column existed have no key, and because a `jobUrl`
     * that isn't a parseable http(s) URL has none to derive. The guard falls back to matching
     * `jobUrl` exactly for those, so an unkeyed row is found exactly as well as it was before.
     */
    jobKey: text('job_key'),
    jobInfo: jsonb('job_info').notNull(),
    tailoredResume: jsonb('tailored_resume').notNull(),
    answers: jsonb('answers').notNull(),
    source: text('source').notNull().default('autofill'),
    stage: text('stage').notNull().default('applied'),
    notes: jsonb('notes').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('applications_job_url_created_at_idx').on(table.jobUrl, table.createdAt.desc()),
    index('applications_job_key_created_at_idx').on(table.jobKey, table.createdAt.desc()),
  ],
);
