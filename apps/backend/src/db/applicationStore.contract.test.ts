/**
 * One suite, both `ApplicationStore` adapters.
 *
 * An in-memory adapter is only worth having if it agrees with Postgres about the things routes rely
 * on — newest-first ordering, what the Duplicate Guard counts as the same posting, which fields a
 * write leaves alone, and (since Phase A, `docs/multi-tenant-auth.md`) that one user's rows are
 * invisible to another's reads and untouchable by another's writes. A fake that disagrees is worse
 * than no fake: every route test then passes against behaviour production does not have, and the
 * disagreement surfaces as a bug in the dashboard rather than as a red test here.
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
const { BOOTSTRAP_USER_ID } = await import('./bootstrapUser.js');
const { contractClient } = (await import('./client.js')) as unknown as {
  contractClient: PGlite;
};

/** The user every non-scoping test in this suite writes and reads as. */
const USER_A = BOOTSTRAP_USER_ID;
/** A second account, present only in the "user scoping" block below. */
const USER_B = '00000000-0000-4000-8000-000000000099';

beforeAll(async () => {
  // Mirrors `db/schema.ts`, including every default — the store writes rows without an id, a
  // stage or notes, exactly as production does.
  await contractClient.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );

    INSERT INTO users (id) VALUES ('${USER_A}'), ('${USER_B}');

    CREATE TABLE applications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
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
      raw_description text,
      extraction_version text,
      requirement_evidence jsonb,
      bullet_provenance jsonb,
      idempotency_key text,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX applications_user_idempotency_key_idx
      ON applications (user_id, idempotency_key);
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
    const { id } = await store.create(USER_A, newApplication({ company: 'Globex' }));

    const stored = await store.byId(USER_A, id);
    expect(stored).toMatchObject({ id, company: 'Globex', jobUrl: 'https://example.com/jobs/1' });
    expect(stored?.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(stored!.createdAt))).toBe(false);
  });

  it('defaults a created application to applied, autofill and no notes', async () => {
    const { id } = await store.create(USER_A, newApplication());

    expect(await store.byId(USER_A, id)).toMatchObject({
      stage: 'applied',
      source: 'autofill',
      notes: [],
    });
  });

  it('answers null for an id no row has', async () => {
    expect(await store.byId(USER_A, '00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });

  it('a repeated idempotency key returns the row the first create wrote, not a second one', async () => {
    const first = await store.create(
      USER_A,
      newApplication({ company: 'First attempt' }),
      'retry-key',
    );
    const second = await store.create(
      USER_A,
      // A resend after a lost response carries the same payload it sent the first time — this
      // deliberately varies it anyway, so the test fails loudly if a same-keyed retry ever
      // overwrote the stored row instead of just handing it back unchanged.
      newApplication({ company: 'Resent attempt' }),
      'retry-key',
    );

    expect(second).toEqual(first);
    expect((await store.list(USER_A)).map((row) => row.id)).toEqual([first.id]);
    expect((await store.byId(USER_A, first.id))?.company).toBe('First attempt');
  });

  it('two keyless creates never collide, matching a caller with nothing to retry', async () => {
    const first = await store.create(USER_A, newApplication({ company: 'First' }));
    const second = await store.create(USER_A, newApplication({ company: 'Second' }));

    expect(second.id).not.toBe(first.id);
    expect((await store.list(USER_A)).map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it('treats an empty idempotency key as absent', async () => {
    const first = await store.create(USER_A, newApplication({ company: 'First' }), '');
    const second = await store.create(USER_A, newApplication({ company: 'Second' }), '');

    expect(second.id).not.toBe(first.id);
  });

  it('the same idempotency key is scoped per user, not shared across accounts', async () => {
    const forA = await store.create(USER_A, newApplication({ company: 'A' }), 'shared-key');
    const forB = await store.create(USER_B, newApplication({ company: 'B' }), 'shared-key');

    expect(forB.id).not.toBe(forA.id);
    expect(await store.byId(USER_A, forA.id)).toMatchObject({ company: 'A' });
    expect(await store.byId(USER_B, forB.id)).toMatchObject({ company: 'B' });
  });

  it('lists every application, most recently created first', async () => {
    const first = await store.create(USER_A, newApplication({ company: 'First' }));
    await afterAMoment();
    const second = await store.create(USER_A, newApplication({ company: 'Second' }));

    expect((await store.list(USER_A)).map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it('lists by exact job url, and excludes a posting reached through a different one', async () => {
    const exact = await store.create(
      USER_A,
      newApplication({ jobUrl: 'https://example.com/jobs/7' }),
    );
    await store.create(
      USER_A,
      newApplication({ jobUrl: 'https://example.com/jobs/7?utm_source=ad' }),
    );

    expect(
      (await store.byJobUrl(USER_A, 'https://example.com/jobs/7')).map((row) => row.id),
    ).toEqual([exact.id]);
  });

  describe('duplicateSummary', () => {
    it('answers a zero count and no latest when nothing matches', async () => {
      expect(await store.duplicateSummary(USER_A, 'https://example.com/jobs/none')).toEqual({
        count: 0,
        latest: null,
      });
    });

    it('matches a posting revisited through a tracking parameter, and counts both', async () => {
      await store.create(USER_A, newApplication({ jobUrl: 'https://example.com/jobs/9' }));
      await afterAMoment();
      const newest = await store.create(
        USER_A,
        newApplication({ company: 'Newest', jobUrl: 'https://example.com/jobs/9?gh_src=ad' }),
      );

      const summary = await store.duplicateSummary(
        USER_A,
        'https://example.com/jobs/9?utm_source=x',
      );

      expect(summary.count).toBe(2);
      expect(summary.latest).toMatchObject({ id: newest.id, company: 'Newest', stage: 'applied' });
    });

    it('reports the newest match, and its current stage rather than its stage at save time', async () => {
      const older = await store.create(
        USER_A,
        newApplication({ jobUrl: 'https://example.com/jobs/11' }),
      );
      await store.setStage(USER_A, older.id, 'rejected');

      const summary = await store.duplicateSummary(USER_A, 'https://example.com/jobs/11');

      expect(summary).toMatchObject({ count: 1, latest: { id: older.id, stage: 'rejected' } });
    });

    it('does not treat a different posting on the same host as the same job', async () => {
      await store.create(USER_A, newApplication({ jobUrl: 'https://example.com/jobs/1' }));

      expect(await store.duplicateSummary(USER_A, 'https://example.com/jobs/2')).toEqual({
        count: 0,
        latest: null,
      });
    });
  });

  describe('replaceSnapshot', () => {
    it('replaces the editable snapshot', async () => {
      const { id } = await store.create(USER_A, newApplication({ company: 'Before' }));

      await store.replaceSnapshot(USER_A, id, {
        company: 'After',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://example.com/jobs/2',
        jobInfo: { ...JOB_INFO, company: 'After' },
        tailoredResume: { skills: ['Go'], workExperience: [] },
        answers: [],
      });

      expect(await store.byId(USER_A, id)).toMatchObject({
        company: 'After',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://example.com/jobs/2',
      });
    });

    it('leaves stage, notes and source alone — a re-save is not a relabelling', async () => {
      const { id } = await store.create(USER_A, newApplication({ source: 'manual' }));
      await store.setStage(USER_A, id, 'onsite');
      await store.appendNote(USER_A, id, { category: 'technical', text: 'Asked about indexes' });

      await store.replaceSnapshot(USER_A, id, {
        company: 'Acme',
        roleTitle: 'Engineer',
        jobUrl: 'https://example.com/jobs/1',
        jobInfo: JOB_INFO,
        tailoredResume: { skills: [], workExperience: [] },
        answers: [],
      });

      expect(await store.byId(USER_A, id)).toMatchObject({
        source: 'manual',
        stage: 'onsite',
        notes: [expect.objectContaining({ text: 'Asked about indexes' })],
      });
    });

    it('re-derives the job key, so a corrected url is what the guard matches on', async () => {
      const { id } = await store.create(
        USER_A,
        newApplication({ jobUrl: 'https://example.com/jobs/1' }),
      );

      await store.replaceSnapshot(USER_A, id, {
        company: 'Acme',
        roleTitle: 'Engineer',
        jobUrl: 'https://example.com/jobs/42',
        jobInfo: JOB_INFO,
        tailoredResume: { skills: [], workExperience: [] },
        answers: [],
      });

      expect(
        await store.duplicateSummary(USER_A, 'https://example.com/jobs/42?utm_source=x'),
      ).toMatchObject({ count: 1, latest: { id } });
      expect(await store.duplicateSummary(USER_A, 'https://example.com/jobs/1')).toEqual({
        count: 0,
        latest: null,
      });
    });

    it('answers null for an id no row has', async () => {
      const result = await store.replaceSnapshot(USER_A, '00000000-0000-4000-8000-0000000000ff', {
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
      const { id } = await store.create(USER_A, newApplication());

      // Including the row the write returned: both adapters carry it back so the route can answer a
      // full-row write without a second query, and an adapter that quietly stopped would send that
      // query back only in production.
      expect(await store.setStage(USER_A, id, 'phone_screen')).toEqual({
        id,
        stage: 'phone_screen',
        application: expect.objectContaining({ id, stage: 'phone_screen' }),
      });
      expect(await store.byId(USER_A, id)).toMatchObject({ stage: 'phone_screen' });
    });

    it('answers null for an id no row has', async () => {
      expect(
        await store.setStage(USER_A, '00000000-0000-4000-8000-0000000000ff', 'rejected'),
      ).toBeNull();
    });
  });

  describe('appendNote', () => {
    it('assigns the note its own id and createdAt rather than taking them from the caller', async () => {
      const { id } = await store.create(USER_A, newApplication());

      const result = await store.appendNote(USER_A, id, {
        category: 'general',
        text: 'Recruiter call',
      });

      expect(result?.note).toMatchObject({ category: 'general', text: 'Recruiter call' });
      expect(result?.note.id).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(result!.note.createdAt))).toBe(false);
    });

    it('appends rather than overwrites, keeping both notes in order', async () => {
      const { id } = await store.create(USER_A, newApplication());

      await store.appendNote(USER_A, id, { category: 'technical', text: 'First' });
      await store.appendNote(USER_A, id, { category: 'behavioral', text: 'Second' });

      const stored = await store.byId(USER_A, id);
      expect(stored?.notes.map((note) => note.text)).toEqual(['First', 'Second']);
    });

    it('answers null for an id no row has', async () => {
      const result = await store.appendNote(USER_A, '00000000-0000-4000-8000-0000000000ff', {
        category: 'general',
        text: 'Nowhere',
      });

      expect(result).toBeNull();
    });
  });

  describe('deleteNote', () => {
    it('removes only the named note, leaving the rest of the log in order', async () => {
      const { id } = await store.create(USER_A, newApplication());
      await store.appendNote(USER_A, id, { category: 'technical', text: 'First' });
      const middle = await store.appendNote(USER_A, id, { category: 'general', text: 'Second' });
      await store.appendNote(USER_A, id, { category: 'behavioral', text: 'Third' });

      const result = await store.deleteNote(USER_A, id, middle!.note.id);

      expect(result).toMatchObject({ id, noteId: middle!.note.id });
      const stored = await store.byId(USER_A, id);
      expect(stored?.notes.map((note) => note.text)).toEqual(['First', 'Third']);
    });

    it('answers null for a note id the row does not have, and changes nothing', async () => {
      // Distinguished from a successful delete, not folded into it: "already gone" and "deleted"
      // look identical in the resulting row, and only the write itself can tell the caller which
      // of the two happened.
      const { id } = await store.create(USER_A, newApplication());
      await store.appendNote(USER_A, id, { category: 'general', text: 'Kept' });

      expect(await store.deleteNote(USER_A, id, 'no-such-note')).toBeNull();
      expect((await store.byId(USER_A, id))?.notes).toHaveLength(1);
    });

    it('answers null for an id no row has', async () => {
      expect(
        await store.deleteNote(USER_A, '00000000-0000-4000-8000-0000000000ff', 'whatever'),
      ).toBeNull();
    });
  });

  describe('deleteApplication', () => {
    it('removes the row entirely and answers with its id', async () => {
      const { id } = await store.create(USER_A, newApplication());

      expect(await store.deleteApplication(USER_A, id)).toEqual({ id });
      expect(await store.byId(USER_A, id)).toBeNull();
      expect((await store.list(USER_A)).map((row) => row.id)).not.toContain(id);
    });

    it('answers null for an id no row has, and touches nothing else', async () => {
      const { id: kept } = await store.create(USER_A, newApplication());

      expect(
        await store.deleteApplication(USER_A, '00000000-0000-4000-8000-0000000000ff'),
      ).toBeNull();
      expect(await store.byId(USER_A, kept)).not.toBeNull();
    });
  });

  /**
   * The property Phase A (`docs/multi-tenant-auth.md`) exists to guarantee: nothing here is
   * reachable, readable or writable by a `userId` other than the one that created it. Every one of
   * `ApplicationStore`'s ten methods gets one case, `duplicateSummary` most deliberately of all —
   * an unscoped guard would tell USER_B "you already applied" to a posting only USER_A has ever seen.
   */
  describe('user scoping', () => {
    it("list only ever returns the calling user's own rows", async () => {
      const mine = await store.create(USER_A, newApplication({ company: 'Mine' }));
      await store.create(USER_B, newApplication({ company: 'Not mine' }));

      expect((await store.list(USER_A)).map((row) => row.id)).toEqual([mine.id]);
    });

    it('byId answers null for a real id that belongs to a different user', async () => {
      const { id } = await store.create(USER_A, newApplication());

      expect(await store.byId(USER_B, id)).toBeNull();
    });

    it('byJobUrl excludes a match on the same URL saved by a different user', async () => {
      await store.create(USER_A, newApplication({ jobUrl: 'https://example.com/jobs/shared' }));

      expect(await store.byJobUrl(USER_B, 'https://example.com/jobs/shared')).toEqual([]);
    });

    it('duplicateSummary never lets one user see another user has already applied', async () => {
      await store.create(USER_A, newApplication({ jobUrl: 'https://example.com/jobs/shared' }));

      expect(await store.duplicateSummary(USER_B, 'https://example.com/jobs/shared')).toEqual({
        count: 0,
        latest: null,
      });
    });

    it('replaceSnapshot answers null and leaves the row untouched for a different user', async () => {
      const { id } = await store.create(USER_A, newApplication({ company: 'Untouched' }));

      const result = await store.replaceSnapshot(USER_B, id, {
        company: 'Hijacked',
        roleTitle: 'Engineer',
        jobUrl: 'https://example.com/jobs/1',
        jobInfo: JOB_INFO,
        tailoredResume: { skills: [], workExperience: [] },
        answers: [],
      });

      expect(result).toBeNull();
      expect(await store.byId(USER_A, id)).toMatchObject({ company: 'Untouched' });
    });

    it('setStage answers null and leaves the row untouched for a different user', async () => {
      const { id } = await store.create(USER_A, newApplication());

      expect(await store.setStage(USER_B, id, 'rejected')).toBeNull();
      expect(await store.byId(USER_A, id)).toMatchObject({ stage: 'applied' });
    });

    it('appendNote answers null and leaves the row untouched for a different user', async () => {
      const { id } = await store.create(USER_A, newApplication());

      expect(
        await store.appendNote(USER_B, id, { category: 'general', text: 'Not yours' }),
      ).toBeNull();
      expect(await store.byId(USER_A, id)).toMatchObject({ notes: [] });
    });

    it('deleteNote answers null and leaves the note in place for a different user', async () => {
      const { id } = await store.create(USER_A, newApplication());
      const note = await store.appendNote(USER_A, id, { category: 'general', text: 'Mine' });

      expect(await store.deleteNote(USER_B, id, note!.note.id)).toBeNull();
      expect((await store.byId(USER_A, id))?.notes).toHaveLength(1);
    });

    it('deleteApplication answers null and leaves the row in place for a different user', async () => {
      const { id } = await store.create(USER_A, newApplication());

      expect(await store.deleteApplication(USER_B, id)).toBeNull();
      expect(await store.byId(USER_A, id)).not.toBeNull();
    });

    it('create assigns the row to the calling user, not whichever user created earlier ones', async () => {
      await store.create(USER_A, newApplication());
      const { id } = await store.create(USER_B, newApplication({ company: 'B-owned' }));

      expect(await store.byId(USER_A, id)).toBeNull();
      expect(await store.byId(USER_B, id)).toMatchObject({ company: 'B-owned' });
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

    const store = inMemoryApplicationStore([{ userId: USER_A, application: seeded }]);

    expect(await store.list(USER_A)).toEqual([seeded]);
    expect(await store.byId(USER_A, 'seed-1')).toEqual(seeded);
  });
});
