import { EMPTY_PROFILE } from '@djobi/shared';
import { describe, expect, it, vi } from 'vitest';
import { backendRoutes, createHttpTransport, HttpError, userMessage } from './index.js';

const jobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Engineer',
  seniority: null,
  location: null,
  requirements: [],
  keywords: [],
};

/** Routes over a real transport whose `fetch` answers every call with `body`, recording each. */
function routesAnswering(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(Response.json(body));
  }) as unknown as typeof globalThis.fetch;
  return { routes: backendRoutes(createHttpTransport({ baseUrl: '', fetch })), calls };
}

describe('backendRoutes', () => {
  it('parses the extract-job body, so a field the route does not accept never leaves', async () => {
    const { routes, calls } = routesAnswering(jobInfo);

    await expect(routes.extractJob('A posting.')).resolves.toEqual(jobInfo);

    expect(calls[0]).toMatchObject({ url: '/extract-job', init: { method: 'POST' } });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ jobDescription: 'A posting.' });
  });

  it('states GET for a bodyless read rather than inheriting the transport default', async () => {
    const { routes, calls } = routesAnswering(null);

    await expect(routes.getProfile()).resolves.toBeNull();

    expect(calls[0]).toMatchObject({ url: '/profile', init: { method: 'GET' } });
  });

  it('encodes the job URL it looks duplicates up by', async () => {
    const { routes, calls } = routesAnswering({ count: 0, latest: null });

    await routes.findApplicationDuplicates('https://jobs.example.com/1?gh_jid=2&x=y');

    expect(calls[0]!.url).toBe(
      `/applications?jobUrl=${encodeURIComponent('https://jobs.example.com/1?gh_jid=2&x=y')}&response=compact`,
    );
    expect(calls[0]!.init).toMatchObject({ method: 'GET' });
  });

  it('rejects a response that does not match the route schema', async () => {
    const { routes } = routesAnswering({ ...jobInfo, requirements: 'Five years of TypeScript' });

    await expect(routes.extractJob('A posting.')).rejects.toThrow();
  });

  it('reports an invalid body as a readable HttpError without sending it', async () => {
    const { routes, calls } = routesAnswering(null);

    const error = await Promise.resolve()
      .then(() => routes.saveProfile({ fullName: 42 } as never))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ kind: 'invalid-request', path: '/profile' });
    // Readable issue text naming the field, not zod's JSON issue dump.
    expect(userMessage(error)).toMatch(/^Some details aren't valid yet: fullName — /);
    expect(calls).toHaveLength(0);
  });

  it('strips a field the profile route does not accept before sending', async () => {
    const { routes, calls } = routesAnswering(EMPTY_PROFILE);

    await routes.saveProfile({ ...EMPTY_PROFILE, notAProfileField: 'private' } as never);

    expect(JSON.parse(calls[0]!.init!.body as string)).not.toHaveProperty('notAProfileField');
  });
});
