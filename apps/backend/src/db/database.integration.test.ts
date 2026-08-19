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

const { getApplicationDuplicateSummary } = await import('./applicationsRepository.js');
const { integrationClient } = (await import('./client.js')) as unknown as {
  integrationClient: PGlite;
};

beforeAll(async () => {
  await integrationClient.exec(`
    CREATE TABLE applications (
      id uuid PRIMARY KEY,
      company text NOT NULL,
      role_title text NOT NULL,
      job_url text NOT NULL,
      job_info jsonb NOT NULL,
      tailored_resume jsonb NOT NULL,
      answers jsonb NOT NULL,
      source text NOT NULL DEFAULT 'autofill',
      stage text NOT NULL DEFAULT 'applied',
      notes jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );

    INSERT INTO applications
      (id, company, role_title, job_url, job_info, tailored_resume, answers, created_at)
    VALUES
      ('00000000-0000-4000-8000-000000000011', 'Acme', 'Engineer I',
       'https://example.com/jobs/1', '{}', '{}', '[]', '2026-01-01T00:00:00Z'),
      ('00000000-0000-4000-8000-000000000012', 'Acme', 'Engineer II',
       'https://example.com/jobs/1', '{}', '{}', '[]', '2026-02-01T00:00:00Z');
  `);
});

afterAll(async () => {
  await integrationClient.close();
});

describe('getApplicationDuplicateSummary integration', () => {
  it('returns the full count and newest projected metadata from one matching row', async () => {
    await expect(getApplicationDuplicateSummary('https://example.com/jobs/1')).resolves.toEqual({
      count: 2,
      latest: {
        id: '00000000-0000-4000-8000-000000000012',
        company: 'Acme',
        roleTitle: 'Engineer II',
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    });
  });

  it('returns the consistent empty summary when no row matches', async () => {
    await expect(
      getApplicationDuplicateSummary('https://example.com/jobs/missing'),
    ).resolves.toEqual({ count: 0, latest: null });
  });

  it('applies the composite index used by the duplicate lookup', async () => {
    const sql = await readFile(
      new URL('./migrations/0005_curved_jackal.sql', import.meta.url),
      'utf8',
    );
    await integrationClient.exec(sql);

    const indexes = await integrationClient.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'applications'
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain(
      'applications_job_url_created_at_idx',
    );
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
