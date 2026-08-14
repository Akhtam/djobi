import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callBackend, callBackendBinary } from './callBackend';

describe('callBackend', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts the body as JSON to the local backend and resolves with the parsed response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ company: 'Acme' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await callBackend('/extract-job', {
      jobDescription: 'Senior Engineer at Acme...',
    });

    expect(result).toEqual({ company: 'Acme' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5391/extract-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobDescription: 'Senior Engineer at Acme...' }),
    });
  });

  it('rejects with the backend error message when the response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'jobDescription is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackend('/extract-job', {})).rejects.toThrow('jobDescription is required');
  });

  it('surfaces a non-JSON error body verbatim instead of failing to parse it — a plain-text 500 used to throw an unrelated SyntaxError, destroying the real cause', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    await expect(callBackend('/answer-questions', {})).rejects.toThrow(
      'POST /answer-questions failed (500): Internal Server Error',
    );
  });

  it('carries the status and path on the thrown BackendError, so callers can report which step failed', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'report_answers did not produce a tool call.' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackend('/answer-questions', {})).rejects.toMatchObject({
      name: 'BackendError',
      status: 500,
      path: '/answer-questions',
      message: expect.stringContaining('report_answers did not produce a tool call.'),
    });
  });

  it("carries the backend's failure kind across the wire, so a caller can tell a retryable model failure from a schema one", async () => {
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

    await expect(callBackend('/answer-questions', {})).rejects.toMatchObject({
      kind: 'no-tool-call',
    });
  });

  it('leaves kind undefined for a failure that was never a structured call', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'jobDescription is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackend('/extract-job', {})).rejects.toMatchObject({ kind: undefined });
  });

  it('reports an empty error body rather than throwing on the empty string', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 502 }));

    await expect(callBackend('/extract-job', {})).rejects.toThrow('empty response body');
  });

  it('sends a bodyless GET request when method is "GET"', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ fullName: 'Jane Doe' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await callBackend('/profile', undefined, 'GET');

    expect(result).toEqual({ fullName: 'Jane Doe' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5391/profile', { method: 'GET' });
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

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5391/render-resume-pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    expect(new Uint8Array(result)).toEqual(pdfBytes);
  });

  it('rejects with the same BackendError shape as callBackend, rather than handing back an error page as if it were a PDF', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'profile is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackendBinary('/render-resume-pdf', {})).rejects.toMatchObject({
      name: 'BackendError',
      status: 400,
      path: '/render-resume-pdf',
      message: expect.stringContaining('profile is required'),
    });
  });
});
