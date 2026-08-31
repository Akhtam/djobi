import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('./schema.js');
  const integrationClient = new PGlite();
  return { db: drizzle(integrationClient, { schema }), integrationClient };
});

const {
  appendNote: addApplicationNote,
  byId: getApplicationById,
  duplicateSummary: getApplicationDuplicateSummary,
  list: listApplications,
  byJobUrl: listApplicationsByJobUrl,
  create: saveApplication,
  replaceSnapshot: updateApplication,
  setStage: updateApplicationStage,
} = (await import('./postgresApplicationStore.js')).postgresApplicationStore;
const { integrationClient } = (await import('./client.js')) as unknown as {
  integrationClient: PGlite;
};

beforeAll(async () => {
  await integrationClient.exec(`
    CREATE TABLE applications (
      -- Mirrors \`db/schema.ts\`, including the default: the repository writes rows without an id,
      -- as production does, and a fixture table that omitted it could only be inserted into by
      -- tests that supplied one — which is how this table came to be exercised by reads alone.
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company text NOT NULL,
      role_title text NOT NULL,
      job_url text NOT NULL,
      job_info jsonb NOT NULL,
      tailored_resume jsonb NOT NULL,
      answers jsonb NOT NULL,
      job_key text,
      source text NOT NULL DEFAULT 'autofill',
      stage text NOT NULL DEFAULT 'applied',
      notes jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );

    INSERT INTO applications
      (id, company, role_title, job_url, job_key, job_info, tailored_resume, answers, stage,
       created_at)
    VALUES
      ('00000000-0000-4000-8000-000000000011', 'Acme', 'Engineer I',
       'https://example.com/jobs/1', 'https://example.com/jobs/1',
       '{}', '{}', '[]', 'applied', '2026-01-01T00:00:00Z'),
      ('00000000-0000-4000-8000-000000000012', 'Acme', 'Engineer II',
       'https://example.com/jobs/1', 'https://example.com/jobs/1',
       '{}', '{}', '[]', 'interviewing', '2026-02-01T00:00:00Z'),
      -- Written before job_key existed: only an exact job_url can find it.
      ('00000000-0000-4000-8000-000000000013', 'Globex', 'Analyst',
       'https://example.com/jobs/legacy?utm_source=old', NULL,
       '{}', '{}', '[]', 'rejected', '2026-03-01T00:00:00Z');
  `);
});

afterAll(async () => {
  await integrationClient.close();
});

const newestForJob1 = {
  count: 2,
  latest: {
    id: '00000000-0000-4000-8000-000000000012',
    company: 'Acme',
    roleTitle: 'Engineer II',
    stage: 'interviewing',
    createdAt: '2026-02-01T00:00:00.000Z',
  },
};

describe('getApplicationDuplicateSummary integration', () => {
  it('returns the full count and newest projected metadata from one matching row', async () => {
    await expect(getApplicationDuplicateSummary('https://example.com/jobs/1')).resolves.toEqual(
      newestForJob1,
    );
  });

  /**
   * The case exact-URL matching missed, and the reason `job_key` exists: the same posting reached
   * through an ad link or from the application screen used to read as a new job and cost a full
   * re-analysis. Each of these normalizes onto the stored key.
   */
  it.each([
    ['tracking parameters', 'https://example.com/jobs/1?utm_source=newsletter&gh_src=board'],
    ['an application-route suffix', 'https://example.com/jobs/1/apply'],
    ['a trailing slash', 'https://example.com/jobs/1/'],
  ])('matches the same posting reached with %s', async (_label, url) => {
    await expect(getApplicationDuplicateSummary(url)).resolves.toEqual(newestForJob1);
  });

  it('still distinguishes postings a query parameter separates', async () => {
    await expect(
      getApplicationDuplicateSummary('https://example.com/jobs/1?jobId=other'),
    ).resolves.toEqual({ count: 0, latest: null });
  });

  it('finds a row written before job_key existed by its exact url', async () => {
    await expect(
      getApplicationDuplicateSummary('https://example.com/jobs/legacy?utm_source=old'),
    ).resolves.toEqual({
      count: 1,
      latest: {
        id: '00000000-0000-4000-8000-000000000013',
        company: 'Globex',
        roleTitle: 'Analyst',
        stage: 'rejected',
        createdAt: '2026-03-01T00:00:00.000Z',
      },
    });
  });

  it('returns the consistent empty summary when no row matches', async () => {
    await expect(
      getApplicationDuplicateSummary('https://example.com/jobs/missing'),
    ).resolves.toEqual({ count: 0, latest: null });
  });

  it.each([
    ['0005_curved_jackal', 'applications_job_url_created_at_idx'],
    ['0006_damp_princess_powerful', 'applications_job_key_created_at_idx'],
  ])('applies the composite index %s adds', async (tag, indexName) => {
    const sql = await readFile(new URL(`./migrations/${tag}.sql`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      // 0006 also adds the column, which the fixture table already declares.
      if (statement.includes('ADD COLUMN')) continue;
      await integrationClient.exec(statement);
    }

    const indexes = await integrationClient.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'applications'
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain(indexName);
  });
});

/**
 * The rest of the repository, against the same in-process Postgres.
 *
 * These read and write through real SQL rather than a mocked `db`, because the SQL *is* the
 * behaviour worth checking here: a window function that counts while projecting one row, a jsonb
 * concatenation that has to be atomic, a derived key that must be re-derived on update, and a list
 * parse that is deliberately more forgiving than the single-row one. The route tests above this
 * layer substitute the repository, so nothing else exercises any of it.
 *
 * Rows are written under their own job URLs so the duplicate-summary fixtures keep their counts.
 */
const jobInfo = {
  company: 'Initech',
  team: 'Platform',
  roleTitle: 'Staff Engineer',
  seniority: 'Staff',
  location: 'Remote',
  requirements: ['Postgres'],
  keywords: ['SQL'],
};

const tailoredResume = {
  skills: ['SQL'],
  workExperience: [
    {
      company: 'Northwind',
      title: 'Engineer',
      startDate: '2021-01',
      endDate: null,
      bullets: ['Wrote the query planner.'],
    },
  ],
};

/** A complete write payload, as `POST /applications` hands one over after parsing. */
function newApplication(overrides: Record<string, unknown> = {}) {
  return {
    company: 'Initech',
    roleTitle: 'Staff Engineer',
    jobUrl: 'https://example.com/jobs/write-1',
    jobInfo,
    tailoredResume,
    answers: [],
    source: 'autofill' as const,
    stage: 'applied' as const,
    notes: [],
    ...overrides,
  };
}

describe('postgresApplicationStore integration', () => {
  it('stores a new application and reads it back parsed, with its defaults applied', async () => {
    const { id } = await saveApplication(
      newApplication({ jobUrl: 'https://example.com/jobs/write-defaults' }),
    );

    await expect(getApplicationById(id)).resolves.toMatchObject({
      id,
      company: 'Initech',
      roleTitle: 'Staff Engineer',
      jobInfo,
      tailoredResume,
      source: 'autofill',
      stage: 'applied',
      notes: [],
    });
    // Assigned by the database, not the caller, and ISO rather than a `Date` — the shape
    // `ApplicationSchema` states and every client parses against.
    const stored = await getApplicationById(id);
    expect(stored?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('derives the Job Key on write, so the guard finds the posting through a tracking link', async () => {
    await saveApplication(newApplication({ jobUrl: 'https://example.com/jobs/keyed' }));

    await expect(
      getApplicationDuplicateSummary('https://example.com/jobs/keyed?utm_source=newsletter'),
    ).resolves.toMatchObject({ count: 1 });
  });

  /**
   * The snapshot can carry a corrected `jobUrl`, so the key is re-derived rather than left alone. A
   * key still pointing at the old URL would make the Duplicate Guard match a posting this row is no
   * longer for — and miss the one it now is.
   */
  it('re-derives the Job Key when a re-save corrects the job URL', async () => {
    const { id } = await saveApplication(
      newApplication({ jobUrl: 'https://example.com/jobs/typo' }),
    );

    await updateApplication(id, {
      company: 'Initech',
      roleTitle: 'Staff Engineer',
      jobUrl: 'https://example.com/jobs/corrected',
      jobInfo,
      tailoredResume,
      answers: [],
    });

    await expect(
      getApplicationDuplicateSummary('https://example.com/jobs/corrected?gh_src=board'),
    ).resolves.toMatchObject({ count: 1 });
    await expect(getApplicationDuplicateSummary('https://example.com/jobs/typo')).resolves.toEqual({
      count: 0,
      latest: null,
    });
  });

  /**
   * `PATCH /applications/:id` takes an `ApplicationSnapshot`, which excludes Stage and Notes exactly
   * so re-saving an autofill run cannot overwrite the interview history recorded against it.
   */
  it('leaves Stage and Notes alone when a snapshot is re-saved over the row', async () => {
    const { id } = await saveApplication(
      newApplication({ jobUrl: 'https://example.com/jobs/resave' }),
    );
    await updateApplicationStage(id, 'interviewing');
    await addApplicationNote(id, { category: 'technical', text: 'Asked about indexes.' });

    await updateApplication(id, {
      company: 'Initech',
      roleTitle: 'Principal Engineer',
      jobUrl: 'https://example.com/jobs/resave',
      jobInfo,
      tailoredResume,
      answers: [],
    });

    await expect(getApplicationById(id)).resolves.toMatchObject({
      roleTitle: 'Principal Engineer',
      stage: 'interviewing',
      notes: [expect.objectContaining({ text: 'Asked about indexes.' })],
    });
  });

  it('answers with the authoritative Stage a move landed on', async () => {
    const { id } = await saveApplication(
      newApplication({ jobUrl: 'https://example.com/jobs/stage' }),
    );

    await expect(updateApplicationStage(id, 'phone_screen')).resolves.toEqual({
      id,
      stage: 'phone_screen',
    });
    await expect(getApplicationById(id)).resolves.toMatchObject({ stage: 'phone_screen' });
  });

  /**
   * The append is one `notes || …` statement rather than a read, a push and a write. Two notes added
   * close together — the dashboard open in two tabs, or a double-submitted form — both read the same
   * array under read-modify-write and the second write silently discards the first. That is exactly
   * the loss an append-only log exists to prevent, so the concatenation happens in Postgres.
   */
  it('keeps both notes when two are appended concurrently', async () => {
    const { id } = await saveApplication(
      newApplication({ jobUrl: 'https://example.com/jobs/notes' }),
    );

    await Promise.all([
      addApplicationNote(id, { category: 'technical', text: 'First note.' }),
      addApplicationNote(id, { category: 'behavioral', text: 'Second note.' }),
    ]);

    const stored = await getApplicationById(id);
    expect(stored?.notes.map((note) => note.text).sort()).toEqual(['First note.', 'Second note.']);
  });

  /**
   * `id` and `createdAt` are generated here and never taken from the caller — the rule `NoteSchema`
   * states, enforced where the note is actually written. A note whose timestamp the sender chose
   * isn't trustworthy history.
   */
  it('assigns each note its own id and timestamp, and answers with the note it wrote', async () => {
    const { id } = await saveApplication(
      newApplication({ jobUrl: 'https://example.com/jobs/note-identity' }),
    );

    const appended = await addApplicationNote(id, {
      category: 'general',
      text: 'They asked about availability.',
    });

    expect(appended).toMatchObject({
      id,
      note: {
        category: 'general',
        text: 'They asked about availability.',
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    await expect(getApplicationById(id)).resolves.toMatchObject({
      notes: [expect.objectContaining({ id: appended!.note.id })],
    });
  });

  const MISSING_ID = '00000000-0000-4000-8000-0000000000ff';

  /**
   * `null` rather than a throw, so the routes above can answer 404. A missing row is an ordinary
   * outcome of a client holding an id for something that has since been deleted.
   */
  it.each([
    ['updateApplicationStage', () => updateApplicationStage(MISSING_ID, 'rejected')],
    [
      'addApplicationNote',
      () => addApplicationNote(MISSING_ID, { category: 'general', text: 'Nowhere.' }),
    ],
    [
      'updateApplication',
      () =>
        updateApplication(MISSING_ID, {
          company: 'Initech',
          roleTitle: 'Staff Engineer',
          jobUrl: 'https://example.com/jobs/missing-row',
          jobInfo,
          tailoredResume,
          answers: [],
        }),
    ],
    ['getApplicationById', () => getApplicationById(MISSING_ID)],
  ])('reports a row that does not exist as null from %s', async (_name, call) => {
    await expect(call()).resolves.toBeNull();
  });

  it('lists an exact job URL, without the postings a Job Key would also match', async () => {
    await saveApplication(newApplication({ jobUrl: 'https://example.com/jobs/exact' }));

    await expect(listApplicationsByJobUrl('https://example.com/jobs/exact')).resolves.toMatchObject(
      [{ jobUrl: 'https://example.com/jobs/exact' }],
    );
    await expect(
      listApplicationsByJobUrl('https://example.com/jobs/exact?utm_source=x'),
    ).resolves.toEqual([]);
  });

  /**
   * The list is deliberately more forgiving than a single-row read: a caller asking for one
   * application is owed an error if it can't be read, but a caller listing the history is owed the
   * history, and one unreadable row from an older build must not hide every other row with it. The
   * fixture rows at the top of this file are exactly that — `'{}'` where a Job Info belongs.
   */
  it('lists the readable rows newest-first and skips the ones an older build wrote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { id } = await saveApplication(
      newApplication({ jobUrl: 'https://example.com/jobs/listed', roleTitle: 'Newest' }),
    );

    const listed = await listApplications();

    expect(listed[0]).toMatchObject({ id, roleTitle: 'Newest' });
    expect(listed.map((application) => application.id)).not.toContain(
      '00000000-0000-4000-8000-000000000011',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping unreadable application'));
    warn.mockRestore();
  });
});

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

async function applySingletonMigration(client: PGlite): Promise<void> {
  const sql = await readFile(
    new URL('./migrations/0004_shocking_wind_dancer.sql', import.meta.url),
    'utf8',
  );
  const statements = sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  await client.exec('BEGIN');
  try {
    for (const statement of statements) await client.exec(statement);
    await client.exec('COMMIT');
  } catch (error) {
    await client.exec('ROLLBACK');
    throw error;
  }
}

async function createLegacyProfilesTable(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE TABLE profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      data jsonb NOT NULL,
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
}

describe('0004 singleton profile migration', () => {
  it('keeps the newest legacy profile, removes duplicates, and assigns the fixed id', async () => {
    const client = new PGlite();
    try {
      await createLegacyProfilesTable(client);
      await client.exec(`
        INSERT INTO profiles (id, data, updated_at) VALUES
          ('00000000-0000-4000-8000-000000000021', '{"fullName":"Older"}', '2026-01-01'),
          ('00000000-0000-4000-8000-000000000022', '{"fullName":"Newest"}', '2026-02-01');
      `);

      await applySingletonMigration(client);

      const result = await client.query<{ id: string; data: { fullName: string } }>(
        'SELECT id, data FROM profiles',
      );
      expect(result.rows).toEqual([{ id: PROFILE_ID, data: { fullName: 'Newest' } }]);

      const column = await client.query<{ column_default: string | null }>(`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name = 'id'
      `);
      expect(column.rows[0].column_default).toBeNull();
    } finally {
      await client.close();
    }
  });

  it('also migrates an empty profiles table', async () => {
    const client = new PGlite();
    try {
      await createLegacyProfilesTable(client);
      await applySingletonMigration(client);
      const result = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM profiles',
      );
      expect(result.rows[0].count).toBe(0);
    } finally {
      await client.close();
    }
  });
});
