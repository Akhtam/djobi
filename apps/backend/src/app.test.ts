/**
 * `handleError` and the `notFound` handler, both registered in `createApp` but general enough to
 * test without its dependencies.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { handleError } from './app.js';
import { createTestApp } from './testApp.js';

describe('handleError', () => {
  it("returns an HTTPException's own response, preserving its status and body", async () => {
    const app = new Hono();
    app.onError(handleError);
    app.get('/', () => {
      throw new HTTPException(413, { message: 'Payload too large' });
    });

    const res = await app.request('/');

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('Payload too large');
  });

  it('answers an ordinary throw as a JSON 500, not the HTTPException path', async () => {
    const app = new Hono();
    app.onError(handleError);
    app.get('/', () => {
      throw new Error('boom');
    });

    const res = await app.request('/');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('GET /healthz', () => {
  it('answers ok with no credential, so an orchestrator can wait on it', async () => {
    const { app } = createTestApp();

    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('notFound', () => {
  it('answers an unregistered path with the same JSON shape every rejection uses', async () => {
    const { app } = createTestApp();

    const res = await app.request('/not-a-route');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
