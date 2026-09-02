import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationWriteResultSchema, DuplicateApplicationSummarySchema } from '@djobi/shared';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { fakeSessionStorage } from './fakeSessionStorage';
import { callBackend, callBackendBinary, callBackendUpload } from './callBackend';

/**
 * A real schema, standing in for whichever route a case is about. The error cases below reject
 * before decoding is reached, so passing one that their fixture body would *fail* is deliberate: it
 * proves the rejection came from the HTTP status, not from the response check.
 */
const Result = ApplicationWriteResultSchema;

describe('callBackend', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    // `callBackend.ts`'s transport reads a bearer token from `chrome.storage.session` on every
    // call (`docs/multi-tenant-auth.md`, Phase D) — empty here, so these tests see the same
    // no-`Authorization`-header requests they did before that existed.
    vi.stubGlobal('chrome', { storage: fakeSessionStorage() });
  });

  it('posts the body as JSON to the local backend and resolves with the parsed response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'application-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await callBackend('/extract-job', Result, {
      jobDescription: 'Senior Engineer at Acme...',
    });

    expect(result).toEqual({ id: 'application-1' });
    expect(fetch).toHaveBeenCalledWith(`${EXTENSION_BACKEND_ORIGIN}/extract-job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobDescription: 'Senior Engineer at Acme...' }),
      // Every call carries a deadline: `fetch` has none of its own, and a request that never
      // settles leaves the Analysis Step waiting forever with no failure to report.
      signal: expect.any(AbortSignal),
    });
  });

  it('combines a caller cancellation signal with the request timeout', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        // Real `fetch` checks `signal.aborted` synchronously on call and rejects immediately for an
        // already-aborted signal, not only a future 'abort' event — this transport now awaits
        // `getAuthorization` before calling `fetch`, so by the time this mock runs, the caller's
        // synchronous `controller.abort()` below may already have landed. A mock that only listened
        // for a future event would hang forever on exactly that ordering, which a real `fetch` never
        // would.
        if (requestSignal?.aborted) {
          reject(requestSignal.reason);
          return;
        }
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();

    const pending = callBackend('/extract-job', Result, {}, 'POST', controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal).not.toBe(controller.signal);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('rejects with the backend error message when the response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'jobDescription is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackend('/extract-job', Result, {})).rejects.toThrow(
      'jobDescription is required',
    );
  });

  it('surfaces a non-JSON error body verbatim instead of failing to parse it — a plain-text 500 used to throw an unrelated SyntaxError, destroying the real cause', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    await expect(callBackend('/answer-questions', Result, {})).rejects.toThrow(
      'POST /answer-questions failed (500): Internal Server Error',
    );
  });

  it('carries the status and path on the thrown HttpError, so callers can report which step failed', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'report_answers did not produce a tool call.' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackend('/answer-questions', Result, {})).rejects.toMatchObject({
      kind: 'http',
      status: 500,
      path: '/answer-questions',
      message: expect.stringContaining('report_answers did not produce a tool call.'),
    });
  });

  it('accepts a legacy error body while dropping metadata that has no extension consumer', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'report_answers did not produce a tool call.',
          kind: 'no-tool-call',
          toolName: 'report_answers',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );

    const error = await callBackend('/answer-questions', Result, {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      kind: 'http',
      status: 500,
      path: '/answer-questions',
      message: expect.stringContaining('report_answers did not produce a tool call.'),
    });
    // The body's own `kind` is backend metadata with no extension consumer. The error's `kind` is
    // the transport's discriminant — `'http'` here — and must not be overwritten by what a route
    // happened to put in its payload.
    expect((error as { kind: string }).kind).toBe('http');
  });

  it('reports an empty error body rather than throwing on the empty string', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 502 }));

    await expect(callBackend('/extract-job', Result, {})).rejects.toThrow('empty response body');
  });

  it('names the path and the failed expectation when a 2xx body is not what the route promised', async () => {
    // A succeeded-and-lied response is a different failure from a request that failed, and the
    // message has to be readable: it reaches the panel verbatim through `run.failure.message`.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const error = await callBackend('/applications', Result, {}).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid-response', path: '/applications' });
    expect((error as Error).message).toContain(
      'POST /applications returned an unexpected response',
    );
    expect((error as Error).message).toContain('id');
  });

  it('treats an empty body as a broken promise rather than resolving with undefined', async () => {
    // The old cast let `undefined` through as whatever the caller claimed, so a route that answered
    // with nothing at all read as a successful call returning a valid value.
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 200 }));

    await expect(callBackend('/applications', Result, {})).rejects.toThrow(
      'returned an unexpected response',
    );
  });

  it('sends a bodyless GET request when method is "GET"', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ count: 0, latest: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await callBackend(
      '/profile',
      DuplicateApplicationSummarySchema,
      undefined,
      'GET',
    );

    expect(result).toEqual({ count: 0, latest: null });
    expect(fetch).toHaveBeenCalledWith(`${EXTENSION_BACKEND_ORIGIN}/profile`, {
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });
});

describe('callBackendBinary', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts the body as JSON and resolves with the raw response bytes', async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70]);
    vi.mocked(fetch).mockResolvedValue(new Response(pdfBytes.buffer, { status: 200 }));

    const profile = { fullName: 'Jane Doe' };
    const result = await callBackendBinary('/render-resume-pdf', { profile });

    expect(fetch).toHaveBeenCalledWith(`${EXTENSION_BACKEND_ORIGIN}/render-resume-pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile }),
      signal: expect.any(AbortSignal),
    });
    expect(new Uint8Array(result)).toEqual(pdfBytes);
  });

  it('rejects with the same HttpError shape as callBackend, rather than handing back an error page as if it were a PDF', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'profile is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackendBinary('/render-resume-pdf', {})).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      path: '/render-resume-pdf',
      message: expect.stringContaining('profile is required'),
    });
  });
});

describe('callBackendUpload', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('chrome', { storage: fakeSessionStorage() });
  });

  it("sends the FormData body untouched, marked for the backend's multipart CSRF guard, and resolves with the parsed response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'application-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const formData = new FormData();
    formData.set('resume', new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }));

    const result = await callBackendUpload('/profile/extract-resume', Result, formData);

    expect(result).toEqual({ id: 'application-1' });
    expect(fetch).toHaveBeenCalledWith(`${EXTENSION_BACKEND_ORIGIN}/profile/extract-resume`, {
      method: 'POST',
      headers: { 'x-djobi-upload': '1' },
      body: formData,
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects with the backend's own message on a rejected upload, the same shape as callBackend", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'No extractable text was found in this PDF.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      callBackendUpload('/profile/extract-resume', Result, new FormData()),
    ).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      message: expect.stringContaining('No extractable text was found in this PDF.'),
    });
  });
});
