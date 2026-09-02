/**
 * The CORS middleware exists for one consumer: `apps/dashboard`, which runs on its own dev server.
 *
 * These tests exist mainly to catch two silent regressions. Middleware registered *after* the
 * routes in `app.ts` still answers a 404 while doing nothing for any real request, so a test that
 * only probed an unknown path would pass against a broken registration — hence the assertions run
 * against a real route. And a wildcard origin would also pass any test that only checked the
 * dashboard's own origin is allowed, hence the disallowed-origin case.
 */
import { describe, expect, it } from 'vitest';

// The assertions below run against `/applications`, a real route, because middleware registered
// after the routes still answers a 404 while doing nothing for a request a route handles. An
// in-memory store is what lets that route answer without a database — there is no module to mock.
import { createTestApp } from './testApp.js';

const { app } = createTestApp();

const DASHBOARD_ORIGIN = 'http://localhost:5174';

describe('CORS', () => {
  it('allows the dashboard origin on a route that actually exists', async () => {
    const res = await app.request('/applications', {
      headers: { origin: DASHBOARD_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(DASHBOARD_ORIGIN);
  });

  it('answers the preflight the dashboard sends before a write', async () => {
    const res = await app.request('/applications/abc', {
      method: 'OPTIONS',
      headers: {
        origin: DASHBOARD_ORIGIN,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(DASHBOARD_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
  });

  it('does not allow an arbitrary origin — any page in the browser can reach 127.0.0.1', async () => {
    const res = await app.request('/applications', {
      headers: { origin: 'https://not-the-dashboard.example' },
    });

    expect(res.headers.get('access-control-allow-origin')).not.toBe(
      'https://not-the-dashboard.example',
    );
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

/**
 * The allowlist above only stops cross-origin reads. A `text/plain` POST is a CORS simple request,
 * so the browser sends it with no preflight for the allowlist to refuse, and `c.req.json()` would
 * have parsed it anyway — the write landed. These cover the guard that closes that path.
 */
describe('content-type guard on writes', () => {
  it('rejects a POST that skips preflight by claiming text/plain', async () => {
    const res = await app.request('/applications', {
      method: 'POST',
      headers: { origin: 'https://not-the-dashboard.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ jobUrl: 'https://example.com/job', company: 'Evil', title: 'x' }),
    });

    expect(res.status).toBe(415);
  });

  it('rejects a PATCH with no content-type at all', async () => {
    const res = await app.request('/applications/abc/stage', {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'applied' }),
    });

    expect(res.status).toBe(415);
  });

  it('lets a declared JSON write through to the route', async () => {
    const res = await app.request('/applications/abc/stage', {
      method: 'PATCH',
      headers: { origin: DASHBOARD_ORIGIN, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ stage: 'applied' }),
    });

    // Whatever the route decides, it decided it — the guard did not short-circuit.
    expect(res.status).not.toBe(415);
  });

  it('leaves reads alone', async () => {
    const res = await app.request('/applications', { headers: { origin: DASHBOARD_ORIGIN } });

    expect(res.status).toBe(200);
  });
});

/**
 * `multipart/form-data` — what `POST /profile/extract-resume` sends — is itself one of the three
 * CORS "simple" content types the guard above exists to close off, so it needs its own check rather
 * than inheriting the `application/json` one. `x-djobi-upload` is a non-simple header, so requiring
 * it forces the same preflight the JSON guard gets for free.
 */
describe('multipart guard on the resume-upload route', () => {
  it('rejects a multipart POST claiming no preflight-forcing header', async () => {
    const form = new FormData();
    form.set('resume', new File(['pdf'], 'r.pdf', { type: 'application/pdf' }));

    const res = await app.request('/profile/extract-resume', {
      method: 'POST',
      headers: { origin: 'https://not-the-dashboard.example' },
      body: form,
    });

    expect(res.status).toBe(415);
  });

  it('answers the preflight for that header, and the allowlist names it', async () => {
    const res = await app.request('/profile/extract-resume', {
      method: 'OPTIONS',
      headers: {
        origin: DASHBOARD_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-djobi-upload',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-djobi-upload');
  });

  it('lets a multipart POST with the header through the guard, past 415', async () => {
    const form = new FormData();
    form.set('resume', new File(['pdf'], 'r.pdf', { type: 'application/pdf' }));

    const res = await app.request('/profile/extract-resume', {
      method: 'POST',
      headers: { origin: DASHBOARD_ORIGIN, 'x-djobi-upload': '1' },
      body: form,
    });

    // Whatever the route decides — this fixture isn't a real PDF — the guard did not short-circuit.
    expect(res.status).not.toBe(415);
  });
});
