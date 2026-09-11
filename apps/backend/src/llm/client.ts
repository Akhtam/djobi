import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';

let cached: OpenRouterProvider | undefined;

/**
 * How the OpenRouter key is found, until an entrypoint overrides it — see
 * {@link configureOpenRouterKey}. `process.env` is the Node default because every entrypoint this
 * repo actually ships today (`index.ts`, `scripts/evalExtraction.ts`) is Node, via `dotenv/config`.
 */
let resolveApiKey: () => string | undefined = () => process.env.OPENROUTER_API_KEY;

/**
 * Overrides how the API key is resolved, and drops any cached provider built under the old one.
 *
 * The seam this repo's future Cloudflare Worker entrypoint (docs/adr/0001) needs and does not have
 * today: a Worker's variables arrive on the request-scoped `env` object `fetch(request, env, ctx)`
 * receives, not on `process.env`. Reading them through `process.env` anyway is possible — Workers
 * can bridge it — but only when `nodejs_compat` and a recent compatibility date are both set in a
 * `wrangler.toml` this repository does not yet have, so that route is a dependency on configuration
 * nobody has committed rather than a fact about the runtime. `configureOpenRouterKey` is what lets
 * that entrypoint hand this module its own `env.OPENROUTER_API_KEY` explicitly instead, the same
 * distinction ADR-0001's porting item now draws: avoiding module-scope binding access is not the
 * same claim as avoiding the `process.env` bridge, and only the first one is true by default here.
 *
 * Not called by anything that ships today — `index.ts`'s default already resolves from
 * `process.env`, lazily, which is the whole fix module-scope evaluation needed.
 */
export function configureOpenRouterKey(resolve: () => string | undefined): void {
  resolveApiKey = resolve;
  cached = undefined;
}

function resolveProvider(): OpenRouterProvider {
  if (cached) return cached;

  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set — copy apps/backend/.env.example to .env and fill it in.',
    );
  }

  cached = createOpenRouter({ apiKey });
  return cached;
}

/**
 * Shared OpenRouter provider. One key and one meter for every model, whoever serves it.
 *
 * `OPENROUTER_API_KEY` replaces `ANTHROPIC_API_KEY`: routing per operation means several vendors,
 * and a key per vendor would be several bills to reconcile against one candidate's run.
 *
 * Lazily resolved on first use, not at import time — the reason is the one `db/client.ts`'s `db`
 * states for itself: Cloudflare Workers evaluate module scope at cold start, before request-scoped
 * bindings are reliably available (docs/adr/0001, porting item 1 — this was the hazard that item
 * named). A `Proxy` forwards every property access to whichever provider `resolveProvider()` builds
 * the first time a route actually calls it, so importing this module (or anything that transitively
 * imports it) never requires a key to be present yet.
 *
 * The proxy target is a function, and the handler traps `apply` as well as `get`, because
 * `OpenRouterProvider` is callable: `openrouter('anthropic/claude-…')` is as much a part of its
 * surface as `openrouter.chat(…)`. A `{}` target would have type-checked and then thrown
 * `openrouter is not a function` at runtime, and would have flipped `typeof openrouter` from
 * `'function'` to `'object'`.
 */
const boundMethods = new WeakMap<OpenRouterProvider, Map<string | symbol, unknown>>();

export const openrouter: OpenRouterProvider = new Proxy(
  function openrouterProvider() {} as unknown as OpenRouterProvider,
  {
    get(target, prop) {
      // None of these is a real call into the provider: `console.log(openrouter)`, `util.inspect`
      // and a `Symbol.toStringTag` read arrive as symbols, `JSON.stringify` probes `toJSON`, and
      // every `await` or `Promise.resolve` probes `then`. Resolving the provider for those threw
      // "OPENROUTER_API_KEY is not set" from a logging statement, with a stack pointing at the log
      // rather than at any route — a missing key should surface where a model is actually used.
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'inspect') {
        return Reflect.get(target, prop) as unknown;
      }

      const provider = resolveProvider();
      const value = Reflect.get(provider, prop, provider);
      if (typeof value !== 'function') return value;

      // Bound so that methods pulled off the proxy (`const { chat } = openrouter`) still run
      // against the real provider rather than against the proxy — and memoized, so that
      // `openrouter.chat === openrouter.chat`. A fresh binding per access silently breaks any
      // consumer that identity-compares or memoizes on a method.
      let bound = boundMethods.get(provider);
      if (!bound) {
        bound = new Map();
        boundMethods.set(provider, bound);
      }
      const existing = bound.get(prop);
      if (existing) return existing;
      const boundValue = (value as (...args: unknown[]) => unknown).bind(provider);
      bound.set(prop, boundValue);
      return boundValue;
    },
    apply(_target, _thisArg, args: unknown[]) {
      return (resolveProvider() as unknown as (...callArgs: unknown[]) => unknown)(...args);
    },
  },
);
