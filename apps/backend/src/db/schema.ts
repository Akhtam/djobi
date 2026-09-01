import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per account. Minimal on purpose — Phase A (multi-tenant auth, `docs/multi-tenant-auth.md`)
 * exists only to give every other table an owner to scope on; there is exactly one row today,
 * `db/bootstrapUser.ts`'s `BOOTSTRAP_USER_ID`, with no auth provider yet issuing real ones. Phase B
 * (the real auth provider) reconciles this table with its own user shape rather than this phase
 * guessing at columns (email, name, …) an auth library will want in its own way.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The base profile, stored whole. `data` holds a `Profile` object (from `@djobi/shared`) as
 * jsonb — no migration is needed when the `Profile` shape changes, since Drizzle just reads/writes
 * whatever is in the column.
 *
 * Keyed by `userId` rather than a separate `id`: one profile per user is a schema guarantee this way
 * rather than a rule to remember, and `postgresProfileStore.saveProfile` stays one atomic upsert on
 * the primary key, exactly as it was on the old singleton `id`.
 */
export const profiles = pgTable('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
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
    /**
     * Whose application this is. `NOT NULL` with no default: every insert must go through code that
     * knows who's asking, which today means `db/bootstrapUser.ts`'s `BOOTSTRAP_USER_ID` and after
     * Phase B means the authenticated request's own id.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
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
    /**
     * The posting text `extractJob` analyzed, and the matching provenance derived from it —
     * `rawDescription`/`extractionVersion`/`requirementEvidence`/`bulletProvenance` on
     * `ApplicationSchema` (`@djobi/shared`). All four nullable: every row written before this
     * migration has none of them, and nothing here backfills a past row.
     */
    rawDescription: text('raw_description'),
    extractionVersion: text('extraction_version'),
    requirementEvidence: jsonb('requirement_evidence'),
    bulletProvenance: jsonb('bullet_provenance'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * All three indexes below lead with `userId`, not just the two the Duplicate Guard uses —
     * doc'd in `docs/multi-tenant-auth.md` as "both existing indexes", written before this one
     * `ORDER BY created_at DESC` scoped by user needed the same prefix it always needed to avoid a
     * per-user sequential scan. Same reasoning as the original unscoped index, just per-user now.
     */
    index('applications_user_job_url_created_at_idx').on(
      table.userId,
      table.jobUrl,
      table.createdAt.desc(),
    ),
    index('applications_user_job_key_created_at_idx').on(
      table.userId,
      table.jobKey,
      table.createdAt.desc(),
    ),
    /**
     * For the unfiltered history — `ApplicationStore.list`, which the dashboard loads on every
     * visit, scoped to one user's rows. Without this one that read is a per-user sequential scan
     * and a sort of the whole table.
     */
    index('applications_user_created_at_idx').on(table.userId, table.createdAt.desc()),
  ],
);
