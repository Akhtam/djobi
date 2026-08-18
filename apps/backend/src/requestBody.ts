/**
 * Reading and validating a request body, and the error that says the *client* got it wrong.
 *
 * Every POST/PATCH handler used to open with the same four lines — `await c.req.json()`, a
 * `safeParse`, and a `c.json({ error }, 400)` — nine times over. That repetition was survivable;
 * what wasn't is the half those four lines never covered. `c.req.json()` *throws* on a body that
 * isn't JSON, no handler caught it, and `app.onError` turns anything thrown into a 500. So a
 * truncated request body came back as a server error and printed the same `console.error` line as
 * the model failing or Postgres being unreachable — the one signal that says "look at the backend"
 * fired for a fault that was never in the backend.
 *
 * `RequestValidationError` is what separates them: it is the only error in this app that means
 * "the request was bad", and `app.onError` answers it with a 400 and no log line.
 */
import type { Context } from 'hono';
import type { z } from 'zod';

/**
 * A request the server understood and refused: a body that isn't JSON, or JSON the route's schema
 * rejects. Answered as a 400 by `app.onError`, and deliberately not logged — it is an expected
 * outcome of an open port, not a fault.
 */
export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

/**
 * The request's body, parsed and validated against `schema`, or a {@link RequestValidationError}
 * naming which of the two failed.
 *
 * Throws rather than returning a result the caller must branch on: a handler that forgets the
 * branch would otherwise run on unvalidated data, and the whole reason this exists is that the
 * un-branched path — the `throw` out of `c.req.json()` — was the one nobody handled.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new RequestValidationError('Request body is not valid JSON.');
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new RequestValidationError(parsed.error.message);
  }

  return parsed.data;
}
