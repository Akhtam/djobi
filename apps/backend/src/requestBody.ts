/**
 * Request validation, and the error meaning the *client* got it wrong. `RequestValidationError`
 * covers both non-JSON bodies and schema failures; `app.onError` answers it with a 400 and no log,
 * keeping "look at the backend" logs for real faults.
 */
import type { Context, Env, MiddlewareHandler } from 'hono';
import type { z } from 'zod';

/** A request the server understood and refused. Answered as a 400, not logged. */
export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

/**
 * The body parsed and validated against `schema`. Throws {@link RequestValidationError} rather than
 * returning a result, so a handler can't forget to branch.
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
 * {@link parseBody} as middleware: declare the schema at registration
 * (`route.post(path, jsonBody(schema), handler)`) and read `c.req.valid('json')`. Not
 * `hono/validator`'s `'json'` target, whose malformed-JSON error bypasses this app's `{ error }`
 * shape.
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

/** {@link jsonBody} for the query string: validates `c.req.query()` into `c.req.valid('query')`. */
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

/** {@link jsonBody} for path parameters: `c.req.valid('param')`. */
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
