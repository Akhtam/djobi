/**
 * Every `/applications` route, driven against in-memory persistence.
 *
 * These used to run against a `vi.mock` of the store module, so each case both arranged a return
 * value and asserted which function had been called with what. That proves the route made a call;
 * it does not prove the call did anything, and it goes on passing when the route starts reaching
 * persistence some other way. Here a write is asserted by reading it back — which is also what
 * makes the "leaves tracking alone" cases mean something, since a mock cannot leave anything alone.
 *
 * The store's own behaviour is not re-asserted here: `db/applicationStore.contract.test.ts` holds
 * the in-memory and Postgres adapters to one interface, so what these cases lean on is behaviour
 * both adapters are known to share.
 */
import type { Application, ApplicationSnapshot } from '@djobi/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { inMemoryApplicationStore } from '../db/applicationStore.js';
import { inMemoryProfileStore } from '../db/profileStore.js';
import { createTestApp } from '../testApp.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

const sampleApplication: Application = {
  id: 'application-1',
  company: 'Acme',
  roleTitle: 'Senior Software Engineer',
  jobUrl: 'https://acme.com/jobs/123',
  jobInfo: {
    company: 'Acme',
    team: 'Platform',
    roleTitle: 'Senior Software Engineer',
    seniority: 'Senior',
    location: 'Remote',
    requirements: ['5+ years of backend experience'],
    keywords: ['TypeScript', 'Postgres'],
  },
  tailoredResume: {
    skills: ['TypeScript'],
    workExperience: [],
  },
  answers: [],
  source: 'autofill',
  stage: 'applied',
  notes: [],
  createdAt: '2026-08-07T00:00:00.000Z',
};

/** The create body: a stored Application minus the two fields the store assigns. */
const { id: _id, createdAt: _createdAt, ...newApplication } = sampleApplication;

/** The re-save body: the create body minus the three fields a snapshot may not write. */
const {
  source: _source,
  stage: _stage,
  notes: _notes,
  ...snapshot
} = newApplication satisfies Record<string, unknown>;

describe('GET /applications', () => {
  it('returns the list of stored applications', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([sampleApplication]);
  });

  it('returns an empty list when no applications have been saved yet', async () => {
    const { app } = createTestApp();

    const res = await app.request('/applications');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns full matching Applications for a legacy job URL lookup', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request(
      `/applications?jobUrl=${encodeURIComponent('https://acme.com/jobs/123')}`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([sampleApplication]);
  });

  it('returns a summary for a compact job URL lookup', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request(
      `/applications?jobUrl=${encodeURIComponent('https://acme.com/jobs/123')}&response=compact`,
    );

    expect(res.status).toBe(200);
    // The compact answer, and only it: no snapshot fields cross the wire.
    expect(await res.json()).toEqual({
      count: 1,
      latest: {
        id: sampleApplication.id,
        company: sampleApplication.company,
        roleTitle: sampleApplication.roleTitle,
        stage: sampleApplication.stage,
        createdAt: sampleApplication.createdAt,
      },
    });
  });

  it('reports no match for a URL never applied to, rather than falling back to the full list', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request(
      '/applications?jobUrl=https%3A%2F%2Facme.com%2Fjobs%2F999&response=compact',
    );

    expect(await res.json()).toEqual({ count: 0, latest: null });
  });
});

describe('GET /applications/:id', () => {
  it('returns the application with the given id', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleApplication);
  });

  it('returns 404 when no application exists with that id', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/does-not-exist');

    expect(res.status).toBe(404);
  });
});

describe('POST /applications', () => {
  it('returns only the generated id for a compact create', async () => {
    const { app, applicationStore } = createTestApp();

    const res = await app.request('/applications?response=compact', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(newApplication),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(Object.keys(body)).toEqual(['id']);
    expect(await applicationStore.byId(body.id)).toMatchObject({ company: 'Acme' });
  });

  /**
   * The optimization the `Written` row exists for, stated as behaviour rather than as a comment: a
   * full-row write answers from what the write returned, so it costs one store call and not two.
   * Against Neon that second call was a second HTTP round trip; a `byId` here would put it back
   * without anything visible changing in the response, which is exactly why it is asserted.
   */
  it('answers a full-row write without reading the row back', async () => {
    const store = inMemoryApplicationStore();
    const byId = vi.fn(store.byId);
    const app = createApp({
      applicationStore: { ...store, byId },
      profileStore: inMemoryProfileStore(),
    });

    const res = await app.request('/applications', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(newApplication),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ company: 'Acme' });
    expect(byId).not.toHaveBeenCalled();
  });

  /**
   * The one case the write cannot answer from its own `RETURNING`: the row landed, but it does not
   * parse as an `Application` — so the store hands back `application: null` and the route falls back
   * to reading it. If that read finds nothing either, the answer is a 404. It used to `throw`, and
   * `app.onError` turns a throw into a 500: a row that isn't there was reported down the channel
   * that means "the backend is broken", beside the model failing and Postgres being unreachable.
   *
   * A store that writes an unreadable row and then forgets it is the cheapest way to reach that
   * path — and it is a stand-in *at the seam* rather than a replaced module, so the route under test
   * is the one that ships.
   */
  it('answers 404, not 500, when the fallback read-back finds nothing', async () => {
    const vanishing = inMemoryApplicationStore();
    const app = createApp({
      applicationStore: {
        ...vanishing,
        create: async (application) => ({
          ...(await vanishing.create(application)),
          application: null,
        }),
        byId: async () => null,
      },
      profileStore: inMemoryProfileStore(),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await app.request('/applications', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(newApplication),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Application not found' });
    // Nothing was logged as a server fault, because nothing about the server failed.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('returns the full saved Application for a legacy create', async () => {
    const { app } = createTestApp();

    const res = await app.request('/applications', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(newApplication),
    });

    expect(await res.json()).toMatchObject({
      company: 'Acme',
      roleTitle: 'Senior Software Engineer',
      jobUrl: 'https://acme.com/jobs/123',
      id: expect.any(String),
      createdAt: expect.any(String),
    });
  });

  it('defaults source, stage and notes when the extension omits them', async () => {
    // The Fill Step posts none of the three; requiring any would 400 every fill.
    const { app, applicationStore } = createTestApp();
    const {
      source: _omitted,
      stage: _alsoOmitted,
      notes: _andThis,
      ...withoutDefaults
    } = newApplication;

    const res = await app.request('/applications?response=compact', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(withoutDefaults),
    });

    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(await applicationStore.byId(id)).toMatchObject({
      source: 'autofill',
      stage: 'applied',
      notes: [],
    });
  });

  /** What the panel's Log tab posts: everything else the same, `source` set explicitly. */
  it('keeps an explicit manual source', async () => {
    const { app, applicationStore } = createTestApp();

    const res = await app.request('/applications?response=compact', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...newApplication, source: 'manual' }),
    });

    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(await applicationStore.byId(id)).toMatchObject({ source: 'manual' });
  });

  it('returns 400 and stores nothing when the body fails validation', async () => {
    const { app, applicationStore } = createTestApp();
    const { company: _company, ...invalidApplication } = newApplication;

    const res = await app.request('/applications', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(invalidApplication),
    });

    expect(res.status).toBe(400);
    expect(await applicationStore.list()).toEqual([]);
  });
});

describe('PATCH /applications/:id', () => {
  it('updates a valid application snapshot', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1?response=compact', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...snapshot,
        roleTitle: 'Staff Engineer',
      } satisfies ApplicationSnapshot),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'application-1' });
    expect(await applicationStore.byId('application-1')).toMatchObject({
      roleTitle: 'Staff Engineer',
    });
  });

  it('preserves tracking fields across a re-save', async () => {
    const tracked: Application = {
      ...sampleApplication,
      source: 'manual',
      stage: 'interviewing',
      notes: [
        {
          id: 'note-1',
          category: 'technical',
          text: 'Kept.',
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      ],
    };
    const { app, applicationStore } = createTestApp({ applications: [tracked] });

    await app.request('/applications/application-1?response=compact', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(snapshot satisfies ApplicationSnapshot),
    });

    expect(await applicationStore.byId('application-1')).toMatchObject({
      source: 'manual',
      stage: 'interviewing',
      notes: tracked.notes,
    });
  });

  it('returns the full updated Application for a legacy snapshot update', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(snapshot),
    });

    expect(await res.json()).toEqual(sampleApplication);
  });

  it('returns 404 when the application no longer exists', async () => {
    const { app } = createTestApp();

    const res = await app.request('/applications/missing', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(snapshot),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 and does not update when tracking fields are included', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...snapshot, roleTitle: 'Rewritten', stage: 'rejected' }),
    });

    expect(res.status).toBe(400);
    expect(await applicationStore.byId('application-1')).toEqual(sampleApplication);
  });

  /**
   * Same guarantee, for the field that says how the record was created: a re-save can't relabel a
   * manually logged application as an autofill.
   */
  it('returns 400 and does not update when the body carries a source', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...snapshot, roleTitle: 'Rewritten', source: 'autofill' }),
    });

    expect(res.status).toBe(400);
    expect(await applicationStore.byId('application-1')).toEqual(sampleApplication);
  });
});

describe('PATCH /applications/:id/stage', () => {
  it('moves an application to a new stage', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1/stage?response=compact', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ stage: 'interviewing' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: 'application-1', stage: 'interviewing' });
    expect(await applicationStore.byId('application-1')).toMatchObject({ stage: 'interviewing' });
  });

  it('returns the full updated Application for a legacy stage change', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1/stage', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ stage: 'interviewing' }),
    });

    await expect(res.json()).resolves.toEqual({ ...sampleApplication, stage: 'interviewing' });
  });

  it('rejects a stage outside the enum rather than writing it', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1/stage', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ stage: 'ghosted' }),
    });

    expect(res.status).toBe(400);
    expect(await applicationStore.byId('application-1')).toMatchObject({ stage: 'applied' });
  });

  it('404s for an application that does not exist', async () => {
    const { app } = createTestApp();

    const res = await app.request('/applications/nope/stage', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ stage: 'applied' }),
    });

    expect(res.status).toBe(404);
  });

  /**
   * A bare `{ stage }` is not an `ApplicationSnapshot`, and that schema is `.strict()` — so if this
   * request reached `PATCH /applications/:id` it would answer 400 rather than 200. The status is
   * what proves the two paths stay apart.
   */
  it('does not reach the snapshot route, whose body would reject a bare stage', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1/stage?response=compact', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ stage: 'applied' }),
    });

    expect(res.status).toBe(200);
    expect(await applicationStore.byId('application-1')).toEqual(sampleApplication);
  });
});

describe('POST /applications/:id/notes', () => {
  it('appends a note, assigning its id and createdAt', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1/notes?response=compact', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ category: 'technical', text: 'Asked about idempotency keys.' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: 'application-1',
      note: {
        id: expect.any(String),
        category: 'technical',
        text: 'Asked about idempotency keys.',
        createdAt: expect.any(String),
      },
    });
    expect((await applicationStore.byId('application-1'))?.notes).toMatchObject([
      { category: 'technical', text: 'Asked about idempotency keys.' },
    ]);
  });

  it('returns the full updated Application for a legacy note append', async () => {
    const { app } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1/notes', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ category: 'technical', text: 'Asked about idempotency keys.' }),
    });

    await expect(res.json()).resolves.toMatchObject({
      id: 'application-1',
      notes: [{ category: 'technical', text: 'Asked about idempotency keys.' }],
    });
  });

  it('ignores a client-supplied id and createdAt — history the sender chose is not history', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    await app.request('/applications/application-1/notes?response=compact', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        category: 'general',
        text: 'Recruiter call.',
        id: 'chosen-by-the-client',
        createdAt: '1999-01-01T00:00:00.000Z',
      }),
    });

    const [note] = (await applicationStore.byId('application-1'))?.notes ?? [];
    expect(note.id).not.toBe('chosen-by-the-client');
    expect(note.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('rejects an unknown category', async () => {
    const { app, applicationStore } = createTestApp({ applications: [sampleApplication] });

    const res = await app.request('/applications/application-1/notes', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ category: 'vibes', text: 'Hmm.' }),
    });

    expect(res.status).toBe(400);
    expect((await applicationStore.byId('application-1'))?.notes).toEqual([]);
  });

  it('404s for an application that does not exist', async () => {
    const { app } = createTestApp();

    const res = await app.request('/applications/nope/notes', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ category: 'general', text: 'Anything.' }),
    });

    expect(res.status).toBe(404);
  });
});
