import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';

let cached: OpenRouterProvider | undefined;

/** Resolves the OpenRouter key; defaults to `process.env` (every shipped entrypoint is Node). */
let resolveApiKey: () => string | undefined = () => process.env.OPENROUTER_API_KEY;

/**
 * Overrides how the API key is resolved and drops any cached provider. For a future Worker
 * entrypoint (ADR-0001), whose secrets arrive on the request's `env` rather than `process.env`.
 * Not called by anything that ships today.
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
 * The shared OpenRouter provider — one key and one bill for every routed model.
 *
 * Lazily built behind a `Proxy` on first use, so importing this never requires the key (Workers
 * evaluate module scope before bindings are available). The target is a function and `apply` is
 * trapped too, because the provider is itself callable.
 */
const boundMethods = new WeakMap<OpenRouterProvider, Map<string | symbol, unknown>>();

export const openrouter: OpenRouterProvider = new Proxy(
  function openrouterProvider() {} as unknown as OpenRouterProvider,
  {
    get(target, prop) {
      // Symbol, `then`, `toJSON` and `inspect` probes come from logging, `await` and
      // `JSON.stringify` — not real use — so they mustn't throw "key not set".
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'inspect') {
        return Reflect.get(target, prop) as unknown;
      }

      const provider = resolveProvider();
      const value = Reflect.get(provider, prop, provider);
      if (typeof value !== 'function') return value;

      // Bound (so destructured methods work) and memoized (so `openrouter.chat ===
      // openrouter.chat`).
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
