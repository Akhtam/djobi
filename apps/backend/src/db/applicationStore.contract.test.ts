/**
 * One suite, both `ApplicationStore` adapters.
 *
 * An in-memory adapter is only worth having if it agrees with Postgres about the things routes rely
 * on — newest-first ordering, what the Duplicate Guard counts as the same posting, and which fields
 * a write leaves alone. A fake that disagrees is worse than no fake: every route test then passes
 * against behaviour production does not have, and the disagreement surfaces as a bug in the
 * dashboard rather than as a red test here.
 *
 * The Postgres side runs against PGlite, the same in-process Postgres `database.integration.test.ts`
 * uses, so the contract is checked against real SQL — real `count(*) over ()`, real jsonb, the real
 * `||` note append — rather than against a second hand-written imitation of it.
 *
 * What is deliberately *not* here: anything only one adapter can do. Dropping an unreadable row from
 * a list is Postgres-only (the in-memory store holds parsed Applications, so there is nothing to
 * drop), and it stays asserted in `database.integration.test.ts`.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Application, NewApplication } from '@djobi/shared';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('./schema.js');
  const contractClient = new PGlite();
  return { db: drizzle(contractClient, { schema }), contractClient };
});

const { inMemoryApplicationStore } = await import('./applicationStore.js');
const { postgresApplicationStore } = await import('./postgresApplicationStore.js');
const { contractClient } = (await import('./client.js')) as unknown as {
  contractClient: PGlite;
};

beforeAll(async () => {
  // Mirrors `db/schema.ts`, including every default — the store writes rows without an id, a
  // stage or notes, exactly as production does.
  await contractClient.exec(`
    CREATE TABLE applications (
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
  `);
});

const JOB_INFO = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: [],
  keywords: [],
};

/** A `NewApplication` as the routes hand one over — every default already applied by zod. */
function newApplication(overrides: Partial<NewApplication> = {}): NewApplication {
  return {
    company: 'Acme',
    roleTitle: 'Engineer',
    jobUrl: 'https://example.com/jobs/1',
    jobInfo: JOB_INFO,
    tailoredResume: { skills: ['TypeScript'], workExperience: [] },
    answers: [],
    source: 'autofill',
    stage: 'applied',
    notes: [],
    ...overrides,
  };
}

/**
 * Two writes far enough apart that both adapters order them the same way.
 *
 * Postgres breaks a `created_at` tie arbitrarily and the in-memory store breaks it by insertion
 * order, so a contract asserting an order across identical timestamps would be asserting the fake's
 * behaviour rather than the shared one. Two milliseconds is the cheapest way to stay inside what
 * both actually promise.
 */
function afterAMoment(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

const ADAPTERS = [
  ['in-memory', async () => inMemoryApplicationStore()],
  [
    'postgres',
    async () => {
      await contractClient.exec('TRUNCATE applications;');
      return postgresApplicationStore;
    },
  ],
] as const;

describe.each(ADAPTERS)('ApplicationStore contract — %s', (_name, freshStore) => {
  let store: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    store = await freshStore();
  });

  it('assigns an id and a createdAt on create, and reads the row back by that id', async () => {
    const { id } = await store.create(newApplication({ company: 'Globex' }));

    const stored = await store.byId(id);
    expect(stored).toMatchObject({ id, company: 'Globex', jobUrl: 'https://example.com/jobs/1' });
    expect(stored?.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(stored!.createdAt))).toBe(false);
  });

  it('defaults a created application to applied, autofill and no notes', async () => {
    const { id } = await store.create(newApplication());

    expect(await store.byId(id)).toMatchObject({ stage: 'applied', source: 'autofill', notes: [] });
  });

  it('answers null for an id no row has', async () => {
    expect(await store.byId('00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });

  it('lists every application, most recently created first', async () => {
    const first = await store.create(newApplication({ company: 'First' }));
    await afterAMoment();
    const second = await store.create(newApplication({ company: 'Second' }));

    expect((await store.list()).map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it('lists by exact job url, and excludes a posting reached through a different one', async () => {
    const exact = await store.create(newApplication({ jobUrl: 'https://example.com/jobs/7' }));
    await store.create(newApplication({ jobUrl: 'https://example.com/jobs/7?utm_source=ad' }));

    expect((await store.byJobUrl('https://example.com/jobs/7')).map((row) => row.id)).toEqual([
      exact.id,
    ]);
  });

  describe('duplicateSummary', () => {
    it('answers a zero count and no latest when nothing matches', async () => {
      expect(await store.duplicateSummary('https://example.com/jobs/none')).toEqual({
        count: 0,
        latest: null,
      });
    });

    it('matches a posting revisited through a tracking parameter, and counts both', async () => {
      await store.create(newApplication({ jobUrl: 'https://example.com/jobs/9' }));
      await afterAMoment();
      const newest = await store.create(
        newApplication({ company: 'Newest', jobUrl: 'https://example.com/jobs/9?gh_src=ad' }),
      );

      const summary = await store.duplicateSummary('https://example.com/jobs/9?utm_source=x');

      expect(summary.count).toBe(2);
      expect(summary.latest).toMatchObject({ id: newest.id, company: 'Newest', stage: 'applied' });
    });

    it('reports the newest match, and its current stage rather than its stage at save time', async () => {
      const older = await store.create(newApplication({ jobUrl: 'https://example.com/jobs/11' }));
      await store.setStage(older.id, 'rejected');

      const summary = await store.duplicateSummary('https://example.com/jobs/11');

      expect(summary).toMatchObject({ count: 1, latest: { id: older.id, stage: 'rejected' } });
    });

    it('does not treat a different posting on the same host as the same job', async () => {
      await store.create(newApplication({ jobUrl: 'https://example.com/jobs/1' }));

      expect(await store.duplicateSummary('https://example.com/jobs/2')).toEqual({
        count: 0,
        latest: null,
      });
    });
  });

  describe('replaceSnapshot', () => {
    it('replaces the editable snapshot', async () => {
      const { id } = await store.create(newApplication({ company: 'Before' }));

      await store.replaceSnapshot(id, {
        company: 'After',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://example.com/jobs/2',
        jobInfo: { ...JOB_INFO, company: 'After' },
        tailoredResume: { skills: ['Go'], workExperience: [] },
        answers: [],
      });

      expect(await store.byId(id)).toMatchObject({
        company: 'After',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://example.com/jobs/2',
      });
    });

    it('leaves stage, notes and source alone — a re-save is not a relabelling', async () => {
      const { id } = await store.create(newApplication({ source: 'manual' }));
      await store.setStage(id, 'interviewing');
      await store.appendNote(id, { category: 'technical', text: 'Asked about indexes' });

      await store.replaceSnapshot(id, {
        company: 'Acme',
        roleTitle: 'Engineer',
        jobUrl: 'https://example.com/jobs/1',
        jobInfo: JOB_INFO,
        tailoredResume: { skills: [], workExperience: [] },
        answers: [],
      });

      expect(await store.byId(id)).toMatchObject({
        source: 'manual',
        stage: 'interviewing',
        notes: [expect.objectContaining({ text: 'Asked about indexes' })],
      });
    });

    it('re-derives the job key, so a corrected url is what the guard matches on', async () => {
      const { id } = await store.create(newApplication({ jobUrl: 'https://example.com/jobs/1' }));

      await store.replaceSnapshot(id, {
        company: 'Acme',
        roleTitle: 'Engineer',
        jobUrl: 'https://example.com/jobs/42',
        jobInfo: JOB_INFO,
        tailoredResume: { skills: [], workExperience: [] },
        answers: [],
      });

      expect(
        await store.duplicateSummary('https://example.com/jobs/42?utm_source=x'),
      ).toMatchObject({ count: 1, latest: { id } });
      expect(await store.duplicateSummary('https://example.com/jobs/1')).toEqual({
        count: 0,
        latest: null,
      });
    });

    it('answers null for an id no row has', async () => {
      const result = await store.replaceSnapshot('00000000-0000-4000-8000-0000000000ff', {
        company: 'Acme',
        roleTitle: 'Engineer',
        jobUrl: 'https://example.com/jobs/1',
        jobInfo: JOB_INFO,
        tailoredResume: { skills: [], workExperience: [] },
        answers: [],
      });

      expect(result).toBeNull();
    });
  });

  describe('setStage', () => {
    it('answers with the authoritative stage and stores it', async () => {
      const { id } = await store.create(newApplication());

      expect(await store.setStage(id, 'phone_screen')).toEqual({ id, stage: 'phone_screen' });
      expect(await store.byId(id)).toMatchObject({ stage: 'phone_screen' });
    });

    it('answers null for an id no row has', async () => {
      expect(await store.setStage('00000000-0000-4000-8000-0000000000ff', 'rejected')).toBeNull();
    });
  });

  describe('appendNote', () => {
    it('assigns the note its own id and createdAt rather than taking them from the caller', async () => {
      const { id } = await store.create(newApplication());

      const result = await store.appendNote(id, { category: 'general', text: 'Recruiter call' });

      expect(result?.note).toMatchObject({ category: 'general', text: 'Recruiter call' });
      expect(result?.note.id).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(result!.note.createdAt))).toBe(false);
    });

    it('appends rather than overwrites, keeping both notes in order', async () => {
      const { id } = await store.create(newApplication());

      await store.appendNote(id, { category: 'technical', text: 'First' });
      await store.appendNote(id, { category: 'behavioral', text: 'Second' });

      const stored = await store.byId(id);
      expect(stored?.notes.map((note) => note.text)).toEqual(['First', 'Second']);
    });

    it('answers null for an id no row has', async () => {
      const result = await store.appendNote('00000000-0000-4000-8000-0000000000ff', {
        category: 'general',
        text: 'Nowhere',
      });

      expect(result).toBeNull();
    });
  });
});

describe('inMemoryApplicationStore', () => {
  it('starts from the applications it is seeded with', async () => {
    const seeded: Application = {
      id: 'seed-1',
      company: 'Seeded',
      roleTitle: 'Engineer',
      jobUrl: 'https://example.com/jobs/seed',
      jobInfo: JOB_INFO,
      tailoredResume: { skills: [], workExperience: [] },
      answers: [],
      source: 'autofill',
      stage: 'applied',
      notes: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const store = inMemoryApplicationStore([seeded]);

    expect(await store.list()).toEqual([seeded]);
    expect(await store.byId('seed-1')).toEqual(seeded);
  });
});
