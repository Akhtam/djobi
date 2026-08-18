import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The base profile, stored whole. `data` holds a `Profile` object (from `@djobi/shared`) as
 * jsonb — no migration is needed when the `Profile` shape changes, since Drizzle just reads/writes
 * whatever is in the column.
 */
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per job the extension has autofilled. `company`/`roleTitle`/`jobUrl` are plain columns
 * so they stay queryable without reaching into JSON; `jobInfo`/`tailoredResume`/`answers` are
 * jsonb snapshots (of `JobInfo`/`TailoredResume`/`QuestionAnswer[]` from `@djobi/shared`) so a past
 * application remains readable even if the schema or tailoring prompt changes later.
 */
export const applications = pgTable('applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  company: text('company').notNull(),
  roleTitle: text('role_title').notNull(),
  jobUrl: text('job_url').notNull(),
  jobInfo: jsonb('job_info').notNull(),
  tailoredResume: jsonb('tailored_resume').notNull(),
  answers: jsonb('answers').notNull(),
  stage: text('stage').notNull().default('applied'),
  notes: jsonb('notes').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
