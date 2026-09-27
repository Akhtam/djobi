import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * One row per account. Better Auth uses this table (`user.modelName: 'users'` in `auth.ts`), so
 * `profiles`/`applications` foreign keys point at the real user.
 *
 * `name`/`email`/`image` are nullable (Better Auth's generator makes them `NOT NULL`) because the
 * migration-`0009` bootstrap row predates them.
 */
export const users = pgTable('users', {
  // `defaultRandom()` is required: Better Auth's Postgres adapter leaves id generation to the
  // column default despite `generateId: 'uuid'`.
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Better Auth's own tables (session, account, verification), following its generated schema except
 * for `uuid` ids with `defaultRandom()` (see `users.id`).
 */
export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    /**
     * Required by `better-auth` at runtime though its CLI generator omits it. OIDC only; nullable.
     */
    issuer: text('issuer'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** The hashed password for the `credential` (email/password) provider; null for OAuth rows. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/**
 * The Profile, stored whole as jsonb (shape changes need no migration). Keyed by `userId`, so one
 * Profile per user is a schema guarantee and saves are a single upsert.
 */
export const profiles = pgTable('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per Application (autofilled or logged by hand). `company`/`roleTitle`/`jobUrl`/`jobKey`
 * are queryable columns; `jobInfo`/`tailoredResume`/`answers` are jsonb snapshots, so a past
 * Application stays readable as schemas and prompts change.
 */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Owner. `NOT NULL` with no default: every insert must know who's asking. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    company: text('company').notNull(),
    roleTitle: text('role_title').notNull(),
    jobUrl: text('job_url').notNull(),
    /**
     * `jobKeyForUrl(jobUrl)` — the Duplicate Guard's match column. Derived server-side, never from
     * the client. Null for older rows and unparseable URLs (the guard falls back to `jobUrl`).
     */
    jobKey: text('job_key'),
    jobInfo: jsonb('job_info').notNull(),
    tailoredResume: jsonb('tailored_resume').notNull(),
    answers: jsonb('answers').notNull(),
    source: text('source').notNull().default('autofill'),
    stage: text('stage').notNull().default('applied'),
    notes: jsonb('notes').notNull().default([]),
    /**
     * Posting text and save-time provenance (`rawDescription`, `extractionVersion`,
     * `requirementEvidence`, `bulletProvenance`). Nullable; older rows aren't backfilled.
     */
    rawDescription: text('raw_description'),
    extractionVersion: text('extraction_version'),
    requirementEvidence: jsonb('requirement_evidence'),
    bulletProvenance: jsonb('bullet_provenance'),
    /**
     * The `idempotency-key` header of the create that wrote this row (never part of the JSON body).
     * Null when none was sent; `NULL`s never collide under the unique index.
     */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Every index leads with `userId`, so per-user reads never sequential-scan. */
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
    /** The dashboard's per-user history, newest first. */
    index('applications_user_created_at_idx').on(table.userId, table.createdAt.desc()),
    /** Target of `saveApplication`'s `ON CONFLICT (user_id, idempotency_key)`. */
    uniqueIndex('applications_user_idempotency_key_idx').on(table.userId, table.idempotencyKey),
  ],
);
