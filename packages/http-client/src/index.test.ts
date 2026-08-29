import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createHttpTransport, HttpError } from './index.js';

const Schema = z.object({ id: z.string() });

/** A `fetch` that answers once with `response`, recording what it was called with. */
function respondWith(build: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  // A fresh Response per call: a body can only be consumed once, so a shared instance makes the
  // second request fail for a reason that has nothing to do with what is under test.
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(build());
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe('createHttpTransport', () => {
  it('prefixes the injected baseUrl, so each app names its own origin', async () => {
    // The reason the origin is a parameter: once deployed the dashboard is same-origin and wants a
    // relative '/api', while the extension needs an absolute URL matching its host permission.
    const { fetchImpl, calls } = respondWith(() => new Response('{"id":"a"}'));
    const relative = createHttpTransport({ baseUrl: '/api', fetch: fetchImpl });

    await relative.json('/applications', Schema);

    expect(calls[0].url).toBe('/api/applications');
  });

  it('sends a body as JSON and defaults the method by whether there is one', async () => {
    const { fetchImpl, calls } = respondWith(() => new Response('{"id":"a"}'));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    await client.json('/profile', Schema);
    await client.json('/profile', Schema, { body: { name: 'Ada' } });

    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(calls[1].init?.method).toBe('POST');
    expect(calls[1].init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[1].init?.body).toBe('{"name":"Ada"}');
  });

  it('reports a non-2xx as an http failure carrying the status and the path', async () => {
    const { fetchImpl } = respondWith(
      () => new Response('{"error":"Application not found"}', { status: 404 }),
    );
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    const error = await client.json('/applications/1', Schema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ kind: 'http', status: 404, path: '/applications/1' });
    expect((error as HttpError).message).toContain('Application not found');
  });

  it('checks the status before reading the body, so a 500 is not reported as a parse error', async () => {
    // A plain-text `Internal Server Error` throws `Unexpected token 'I'` if parsed first, which is
    // how a real backend failure used to reach the UI wearing an unrelated cause.
    const { fetchImpl } = respondWith(() => new Response('Internal Server Error', { status: 500 }));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    const error = await client.json('/tailor-resume', Schema).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'http', status: 500 });
    expect((error as HttpError).message).toContain('Internal Server Error');
  });

  it('reports a 2xx body that is not JSON as an invalid response, not as a raw SyntaxError', async () => {
    // Both apps used to let `JSON.parse` throw straight past the error type each had defined for
    // exactly this case.
    const { fetchImpl } = respondWith(() => new Response('<!doctype html><html>', { status: 200 }));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    const error = await client.json('/profile', Schema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ kind: 'invalid-response', path: '/profile' });
  });

  it('reports a 2xx body of the wrong shape as an invalid response, naming what was wrong', async () => {
    const { fetchImpl } = respondWith(() => new Response('{"nope":1}', { status: 200 }));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    const error = await client.json('/tailor-resume', Schema).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'invalid-response' });
    expect((error as HttpError).message).toContain('id');
  });

  it('treats an empty 2xx body as a route that did not do what it said', async () => {
    const { fetchImpl } = respondWith(() => new Response('', { status: 200 }));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    await expect(client.json('/profile', Schema)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('reports an unreachable backend with the app\'s own remedy, not "Failed to fetch"', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpTransport({
      baseUrl: 'http://127.0.0.1:5391',
      fetch: fetchImpl,
      unreachableMessage: 'Is it running? (pnpm dev:backend)',
    });

    const error = await client.json('/applications', Schema).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'network', path: '/applications' });
    expect((error as HttpError).message).toBe('Is it running? (pnpm dev:backend)');
  });

  it('keeps the original TypeError as the cause, so a construction fault is still diagnosable', () => {
    // The `'network'` message is written for the common cause and describes every other one wrongly.
    // Nothing was lost mapping it, so the real reason is one hop away rather than gone.
    const underlying = new TypeError('Failed to parse URL from ///');
    const fetchImpl = vi.fn(() => Promise.reject(underlying)) as unknown as typeof globalThis.fetch;
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    return client.json('/applications', Schema).catch((error: unknown) => {
      expect((error as HttpError).cause).toBe(underlying);
    });
  });

  it('refuses a body on a GET rather than letting fetch report it as an unreachable backend', async () => {
    // `fetch` rejects this with a `TypeError`, indistinguishable by then from nothing listening on
    // the port — so the caller would be told to start a backend that is already running.
    const { fetchImpl } = respondWith(() => new Response('{"id":"a"}'));
    const client = createHttpTransport({
      baseUrl: '',
      fetch: fetchImpl,
      unreachableMessage: 'Is it running? (pnpm dev:backend)',
    });

    const error = await client
      .json('/profile', Schema, { method: 'GET', body: { name: 'Ada' } })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('GET /profile was given a body');
    expect(error).not.toBeInstanceOf(HttpError);
    // Never sent, and never silently sent without its body either.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('abandons a call whose body never arrives, not merely one whose headers never do', async () => {
    // The extension's deadline used to wrap `fetch` alone, so a backend that answered its headers
    // and then stalled mid-body was never given up on.
    const { fetchImpl } = respondWith(
      () =>
        new Response(
          new ReadableStream({
            start() {
              // never enqueues, never closes
            },
          }),
          { status: 200 },
        ),
    );
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl, timeoutMs: 20 });

    const error = await client.json('/extract-job', Schema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ kind: 'timeout', path: '/extract-job' });
  });

  it("lets the caller's own cancellation propagate as itself, rather than reporting a timeout", async () => {
    // A pipeline run aborts superseded model work on re-analysis. That is not a failure anyone
    // should see reported, and it must not be rewritten into the deadline's error.
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl, timeoutMs: 5_000 });

    const pending = client.json('/tailor-resume', Schema, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('carries a signal on the binary route too, so no route is the one that cannot be cancelled', async () => {
    // `/render-resume-pdf` is real generation cost inside the Fill Step, and the old
    // `callBackendBinary` took no signal at all.
    const { fetchImpl, calls } = respondWith(() => new Response(new Uint8Array([37, 80, 68, 70])));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });
    const controller = new AbortController();

    const bytes = await client.binary('/render-resume-pdf', {
      body: { a: 1 },
      signal: controller.signal,
    });

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(calls[0].init?.signal).toBeDefined();
  });

  it('reports a non-2xx on the binary route rather than handing back an error page as a PDF', async () => {
    const { fetchImpl } = respondWith(() => new Response('{"error":"boom"}', { status: 500 }));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    await expect(client.binary('/render-resume-pdf', { body: {} })).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
  });

  it('uses the transport it was given rather than the global fetch', async () => {
    const { fetchImpl } = respondWith(() => new Response('{"id":"a"}'));
    const client = createHttpTransport({ baseUrl: '', fetch: fetchImpl });

    await client.json('/profile', Schema);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
