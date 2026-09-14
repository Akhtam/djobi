/**
 * The three ways a request body can fail, which used to be two behaviours wearing one status.
 *
 * A body that isn't JSON at all threw a `SyntaxError` out of `c.req.json()` and fell into
 * `app.onError`, which turns anything thrown into a 500 — so a client sending garbage got the same
 * status, and produced the same `console.error` line, as the model failing or Postgres being down.
 * The status was wrong and the log signal was worse: a genuine backend fault and a truncated
 * request body were indistinguishable in the terminal.
 *
 * Asserted against a real route rather than a stub app, since the whole point is how `parseBody`
 * and `app.onError` compose in the app the server actually runs.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handleError } from './app.js';
import { pathParams, queryParams } from './requestBody.js';

const mockExtractJob = vi.fn();
vi.mock('./llm/extractJob.js', () => ({
  extractJob: (...args: unknown[]) => mockExtractJob(...args),
}));

const { createTestApp } = await import('./testApp.js');

const { app } = createTestApp();

const JSON_HEADERS = { 'content-type': 'application/json' };

function post(body: string) {
  return app.request('/extract-job', { method: 'POST', headers: JSON_HEADERS, body });
}

describe('request body validation', () => {
  it('answers 400 when the body is not JSON at all', async () => {
    mockExtractJob.mockReset();

    const res = await post('{ truncated');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining('not valid JSON') });
    expect(mockExtractJob).not.toHaveBeenCalled();
  });

  it('answers 400 when the body is JSON the schema rejects', async () => {
    mockExtractJob.mockReset();

    const res = await post(JSON.stringify({ jobDescription: '' }));

    expect(res.status).toBe(400);
    expect(mockExtractJob).not.toHaveBeenCalled();
  });

  it('returns 500 with a generic message when a valid body causes a runtime error, never leaking internal details', async () => {
    mockExtractJob.mockReset().mockRejectedValue(new Error('model unavailable'));
    // `app.onError` logs this deliberately — that a genuine fault *is* logged is the point of the
    // case below. Silenced here so a green run doesn't print a stack trace nobody needs to read.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post(JSON.stringify({ jobDescription: 'a real posting' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not log a rejected body as a server failure', async () => {
    mockExtractJob.mockReset();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await post('{ truncated');

    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('logs a genuine failure behind a valid body', async () => {
    mockExtractJob.mockReset().mockRejectedValue(new Error('model unavailable'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await post(JSON.stringify({ jobDescription: 'a real posting' }));

    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

/**
 * `queryParams`/`pathParams` on a throwaway app rather than a real route: every schema this backend
 * actually registers them with (`routes/applications.ts`) is deliberately permissive enough that no
 * real request can fail it — the point there is stating a route's shape, not rejecting anything new.
 * These prove the mechanism itself — reject-before-handler, expose after — with a schema strict
 * enough to exercise both paths.
 */
describe('queryParams', () => {
  const app = new Hono();
  app.onError(handleError);
  app.get('/items', queryParams(z.object({ limit: z.coerce.number().int().positive() })), (c) =>
    c.json(c.req.valid('query')),
  );

  it('answers 400, unlogged, and never reaches the handler when the query fails the schema', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await app.request('/items?limit=not-a-number');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('exposes the validated, coerced query through c.req.valid', async () => {
    const res = await app.request('/items?limit=5');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limit: 5 });
  });
});

describe('pathParams', () => {
  const app = new Hono();
  app.onError(handleError);
  app.get('/items/:id', pathParams(z.object({ id: z.string().uuid() })), (c) =>
    c.json(c.req.valid('param')),
  );

  it('answers 400 and never reaches the handler when a path segment fails the schema', async () => {
    const res = await app.request('/items/not-a-uuid');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('exposes the validated param through c.req.valid', async () => {
    const id = '11111111-1111-4111-8111-111111111111';

    const res = await app.request(`/items/${id}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id });
  });
});
