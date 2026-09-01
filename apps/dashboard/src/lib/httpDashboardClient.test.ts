/**
 * The HTTP client against a stubbed `fetch`.
 *
 * The fixture client makes every view testable without a network, which means nothing else in this
 * suite would notice if the real adapter called the wrong path, the wrong method, or dropped the
 * body. These tests cover exactly that seam — the paths and bodies are checked against what
 * `apps/backend/src/routes/applications.ts` actually registers.
 */
import type { Application } from '@djobi/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@djobi/http-client';
import { httpDashboardClient } from './dashboardClient';
import { fixtureApplications } from './fixtures';

const sample: Application = fixtureApplications[0];

function stubFetch(response: { ok?: boolean; status?: number; jsonBody?: unknown }) {
  // `?? {}` would have flattened an explicit `jsonBody: null` — a real response, `GET /profile`'s
  // answer for a candidate with none saved — into the no-body-given default. Only a caller who
  // omitted `jsonBody` entirely gets the `{}` stand-in.
  const body = 'jsonBody' in response ? response.jsonBody : {};
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listApplications', () => {
  it('GETs /applications and validates the rows', async () => {
    const fetchMock = stubFetch({ jsonBody: [sample] });

    await expect(httpDashboardClient.listApplications()).resolves.toEqual([sample]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:5391/applications', {
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects a row that is not an Application instead of handing it to the views', async () => {
    stubFetch({ jsonBody: [{ id: 'x' }] });
    await expect(httpDashboardClient.listApplications()).rejects.toThrow();
  });
});

describe('getProfile', () => {
  it('GETs /profile and validates it', async () => {
    const profile = {
      fullName: 'Jordan Rivera',
      email: 'jordan.rivera@example.com',
      phone: null,
      location: null,
      links: { linkedin: null, portfolio: null, github: null },
      workExperience: [],
      maxBulletsPerRole: 6,
      education: [],
      skills: ['TypeScript'],
      stories: [],
      screeningAnswers: {},
      customAnswers: [],
    };
    const fetchMock = stubFetch({ jsonBody: profile });

    await expect(httpDashboardClient.getProfile()).resolves.toEqual({
      ...profile,
      resumePageSize: 'A4',
      showRolePrefix: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:5391/profile', {
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  it('resolves null for a candidate who has not set a Profile up, rather than failing to parse it', async () => {
    stubFetch({ jsonBody: null });

    await expect(httpDashboardClient.getProfile()).resolves.toBeNull();
  });
});

describe('updateStage', () => {
  it('PATCHes the stage route with a bare { stage } body', async () => {
    const fetchMock = stubFetch({ jsonBody: { id: sample.id, stage: 'rejected' } });

    await httpDashboardClient.updateStage('app-brex', 'rejected');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5391/applications/app-brex/stage?response=compact',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'rejected' }),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('escapes an id rather than letting it change the path', async () => {
    const fetchMock = stubFetch({ jsonBody: { id: 'a/b', stage: 'applied' } });

    await httpDashboardClient.updateStage('a/b', 'applied');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:5391/applications/a%2Fb/stage?response=compact',
    );
  });
});

describe('addNote', () => {
  it('POSTs the note route with only the fields the server accepts', async () => {
    const fetchMock = stubFetch({
      jsonBody: {
        id: sample.id,
        note: {
          id: 'note-1',
          category: 'technical',
          text: 'Race condition.',
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      },
    });

    await httpDashboardClient.addNote('app-brex', {
      category: 'technical',
      text: 'Race condition.',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5391/applications/app-brex/notes?response=compact',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'technical', text: 'Race condition.' }),
        signal: expect.any(AbortSignal),
      },
    );
  });
});

describe('failures', () => {
  it('reports the backend’s own error message, not a parse error', async () => {
    stubFetch({ ok: false, status: 404, jsonBody: { error: 'Application not found' } });

    await expect(httpDashboardClient.updateStage('nope', 'applied')).rejects.toThrow(
      /Application not found/,
    );
  });

  it('turns an unreachable backend into something that names the cause', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    // "Failed to fetch" on its own tells the user nothing actionable.
    await expect(httpDashboardClient.listApplications()).rejects.toThrow(/Is it running/);
    await expect(httpDashboardClient.listApplications()).rejects.toBeInstanceOf(HttpError);
  });

  it('aborts a stalled request and reports a timeout', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }),
    );

    const request = httpDashboardClient.listApplications();
    controller.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(request).rejects.toThrow(/did not respond within 90s/);
  });

  it('reports the same timeout when the backend stalls after sending headers', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
        }),
      ),
    );

    const request = httpDashboardClient.listApplications();
    await Promise.resolve();
    controller.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(request).rejects.toThrow(/did not respond within 90s/);
  });
});
