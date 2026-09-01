import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per account. Phase A (`docs/multi-tenant-auth.md`) created this with only `id`/`createdAt`
 * — enough to give every other table an owner to scope on, with no auth provider yet issuing real
 * ids. Phase B widens it in place rather than letting Better Auth generate a second `user` table of
 * its own: `auth.ts`'s `user.modelName: 'users'` points Better Auth at this exact table, so
 * `profiles`/`applications`' existing foreign keys need no migration of their own.
 *
 * `name`/`email`/`image` are nullable and `emailVerified` defaults `false` — Better Auth's own
 * generator (`pnpm exec better-auth generate`, run once to discover this shape, output not kept)
 * marks `name`/`email` `NOT NULL`, which the row Phase A's migration already inserted
 * (`db/bootstrapUser.ts`'s `BOOTSTRAP_USER_ID`) cannot satisfy retroactively. Every row Better Auth
 * itself creates supplies all four; the bootstrap row is the one exception, and stays queryable
 * rather than becoming un-migratable. How that one row acquires a real login is Phase B's own open
 * question — see the chunk notes rather than assuming it here.
 */
export const users = pgTable('users', {
  // `.defaultRandom()` added in Phase B: Better Auth's Postgres adapter defers id generation to the
  // database's own column default regardless of `auth.ts`'s `generateId: 'uuid'` — confirmed by
  // `auth.test.ts` failing a NOT NULL violation without it. Every insert before Phase B (Phase A's
  // migration 0009) already supplied an explicit id, so this is additive, not a behavior change for
  // existing callers.
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
 * Better Auth's own tables — session, OAuth/credential account, and email-verification tokens.
 * Nothing existing referenced these before Phase B, so unlike `users` there is no reconciliation:
 * table and column shapes follow Better Auth's own generated schema exactly, except `id`/`userId`
 * are `uuid` rather than its default `text`, and every `id` is `.defaultRandom()` — see the note on
 * `users.id` above for why that default, not `auth.ts`'s config, is what actually generates it on
 * Postgres.
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
     * Missing entirely from `@better-auth/cli generate`'s output (v1.4.21) but required by
     * `better-auth` itself (v1.7.2) at runtime — the two are versioned separately, and `auth.test.ts`
     * caught the drift as a real `BetterAuthError` (`The field "issuer" does not exist`) rather than
     * a silent gap. Nullable: only relevant to OIDC-style providers.
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
