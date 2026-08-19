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
import { describe, expect, it, vi } from 'vitest';

const mockExtractJob = vi.fn();
vi.mock('./llm/extractJob.js', () => ({
  extractJob: (...args: unknown[]) => mockExtractJob(...args),
}));

// Mirrors the module's full export surface — an incomplete factory fails at import time inside the
// route rather than here.
vi.mock('./db/applicationsRepository.js', () => ({
  listApplications: vi.fn(async () => []),
  listApplicationsByJobUrl: vi.fn(async () => []),
  getApplicationDuplicateSummary: vi.fn(async () => ({ count: 0, latest: null })),
  getApplicationById: vi.fn(async () => null),
  saveApplication: vi.fn(),
  updateApplication: vi.fn(),
  updateApplicationStage: vi.fn(),
  addApplicationNote: vi.fn(),
}));

const { app } = await import('./app.js');

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

  it('still answers 500 when the work behind a valid body throws', async () => {
    mockExtractJob.mockReset().mockRejectedValue(new Error('model unavailable'));

    const res = await post(JSON.stringify({ jobDescription: 'a real posting' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'model unavailable' });
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
