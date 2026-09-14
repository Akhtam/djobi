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
import type { Context, Env, MiddlewareHandler } from 'hono';
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
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
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

/**
 * {@link parseBody} as middleware, so a route declares its body's shape where it registers the
 * route (`route.post(path, jsonBody(schema), handler)`) and reads the validated result back
 * through `c.req.valid('json')` — Hono's own validate-then-read convention (`hono/validator`,
 * `@hono/zod-validator`) — rather than an inline `await parseBody(c, schema)` in the handler body.
 *
 * Built on `parseBody` rather than `hono/validator`'s own `'json'` target: that target parses the
 * body itself and throws a bare `HTTPException` with its own message on malformed JSON, before this
 * module's schema ever runs — which would answer with a different status text than the rest of this
 * app's `{ error }` convention for the exact same fault. Reusing `parseBody` keeps one behavior
 * (and one `RequestValidationError` message) for "the body wasn't JSON", however it's reached.
 */
export function jsonBody<T extends z.ZodType, E extends Env = Env>(
  schema: T,
): MiddlewareHandler<E, string, { in: { json: z.input<T> }; out: { json: z.infer<T> } }> {
  return async (c, next) => {
    // zod 4 leaves a generic schema's output unconstrained (it could be `undefined`), which Hono's
    // `addValidatedData` refuses; every schema routed through here describes an object.
    c.req.addValidatedData('json', (await parseBody(c, schema)) as object);
    await next();
  };
}

/**
 * {@link jsonBody}'s counterpart for the query string: validates `c.req.query()` against `schema`
 * and exposes the result through `c.req.valid('query')`.
 *
 * Unlike a JSON body, reading the query string never throws — there's no "not even parseable" case
 * to reconcile with this app's error shape the way {@link jsonBody} has to for `hono/validator`'s
 * own `'json'` target, so this reads `c.req.query()` directly rather than needing a `parseBody`-like
 * wrapper. `c.req.query()` with no key returns the same first-value-per-key object individual
 * `c.req.query(key)` calls already read, so wiring a route through this changes nothing about which
 * values reach the schema.
 */
export function queryParams<T extends z.ZodType, E extends Env = Env>(
  schema: T,
): MiddlewareHandler<E, string, { in: { query: z.input<T> }; out: { query: z.infer<T> } }> {
  return async (c, next) => {
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new RequestValidationError(parsed.error.message);
    }
    c.req.addValidatedData('query', parsed.data as object);
    await next();
  };
}

/**
 * {@link queryParams}, for path parameters — `c.req.valid('param')`.
 *
 * A route's own path pattern already guarantees every `:name` segment is a non-empty string before
 * a handler ever sees it, so this can't reject a request Hono's router would otherwise have routed
 * here. It exists for the same reason {@link jsonBody} states a route's body shape at registration
 * rather than leaving it to be inferred from `c.req.param('id')` calls scattered through the
 * handler: the schema is what a route expects, read in one place instead of assumed at each call.
 */
export function pathParams<T extends z.ZodType, E extends Env = Env>(
  schema: T,
): MiddlewareHandler<E, string, { in: { param: z.input<T> }; out: { param: z.infer<T> } }> {
  return async (c, next) => {
    const parsed = schema.safeParse(c.req.param());
    if (!parsed.success) {
      throw new RequestValidationError(parsed.error.message);
    }
    c.req.addValidatedData('param', parsed.data as object);
    await next();
  };
}
