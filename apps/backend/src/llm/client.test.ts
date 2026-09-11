/**
 * The lazy `openrouter` proxy and its injected key resolver — see `docs/adr/0001`'s porting item 1
 * for why the resolver is injected rather than a hardcoded `process.env` read copied verbatim from
 * `db/client.ts`'s own lazy proxy, which this module otherwise mirrors closely enough that its own
 * test file (`db/client.test.ts`) is the template for this one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createOpenRouter } = vi.hoisted(() => ({
  createOpenRouter: vi.fn((options: { apiKey: string }) => ({
    chat: (modelId: string) => `model:${modelId}:${options.apiKey}`,
  })),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter }));

/** A fresh module registry per case, since the resolved provider is cached in module scope. */
async function importClient() {
  vi.resetModules();
  createOpenRouter.mockClear();
  return import('./client.js');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

describe('the OpenRouter client', () => {
  it('imports without OPENROUTER_API_KEY set, so a route test needs no .env to load the app', async () => {
    const { openrouter } = await importClient();

    expect(openrouter).toBeDefined();
    expect(createOpenRouter).not.toHaveBeenCalled();
  });

  it('names the missing configuration and how to supply it, on first use', async () => {
    const { openrouter } = await importClient();

    expect(() => openrouter.chat).toThrow(/OPENROUTER_API_KEY is not set/);
    expect(() => openrouter.chat).toThrow(/apps\/backend\/\.env\.example/);
  });

  it('resolves the key set after import, not the one present when the module first loaded', async () => {
    // Node's own default resolver reads `process.env` lazily, not once — so a key set anywhere
    // between import and first use (e.g. `dotenv/config` finishing asynchronously) still works.
    const { openrouter } = await importClient();

    process.env.OPENROUTER_API_KEY = 'sk-late';
    expect(openrouter.chat).toBeDefined();
    expect(createOpenRouter).toHaveBeenCalledWith({ apiKey: 'sk-late' });
  });

  it('builds the provider on first use, and once — every later property comes from the same one', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const { openrouter } = await importClient();

    expect(openrouter.chat).toBeDefined();
    expect(openrouter.chat).toBeDefined();

    expect(createOpenRouter).toHaveBeenCalledTimes(1);
    expect(createOpenRouter).toHaveBeenCalledWith({ apiKey: 'sk-test' });
  });

  /**
   * `console.log(openrouter)`, `util.inspect`, a `Symbol.toStringTag` read and the `then` probe
   * every `await` performs all reach the proxy's `get`. Resolving the provider for those threw
   * "OPENROUTER_API_KEY is not set" from a logging statement, with a stack pointing at the log
   * rather than at any route — a missing key should surface where a model is actually used.
   */
  it('does not resolve the provider for a logging or inspection read, so a missing key throws at the route', async () => {
    const { openrouter } = await importClient();

    expect(() => String(openrouter[Symbol.toStringTag as never])).not.toThrow();
    expect(() => JSON.stringify({ openrouter })).not.toThrow();
    expect(() => (openrouter as unknown as { then?: unknown }).then).not.toThrow();
    expect(createOpenRouter).not.toHaveBeenCalled();

    // The real use still throws, which is the behaviour the exemption must not weaken.
    expect(() => openrouter.chat).toThrow(/OPENROUTER_API_KEY is not set/);
  });

  it('awaits without hanging or throwing, since the then probe never reaches the provider', async () => {
    const { openrouter } = await importClient();

    await expect(Promise.resolve(openrouter)).resolves.toBeDefined();
    expect(createOpenRouter).not.toHaveBeenCalled();
  });

  /**
   * Methods are bound so that `const { chat } = openrouter` still runs against the real provider.
   * Binding afresh on every access made `openrouter.chat !== openrouter.chat`, which silently
   * breaks any consumer that memoizes or identity-compares a method.
   */
  it('hands back the same bound method every time, so identity comparison holds', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const { openrouter } = await importClient();

    expect(openrouter.chat).toBe(openrouter.chat);
    expect(openrouter.chat('anthropic/claude')).toBe('model:anthropic/claude:sk-test');
  });

  it('lets configureOpenRouterKey override where the key comes from', async () => {
    const { openrouter, configureOpenRouterKey } = await importClient();
    configureOpenRouterKey(() => 'sk-injected');

    expect(openrouter.chat).toBeDefined();
    expect(createOpenRouter).toHaveBeenCalledWith({ apiKey: 'sk-injected' });
  });

  it('drops the cached provider when the resolver is reconfigured', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-first';
    const { openrouter, configureOpenRouterKey } = await importClient();
    void openrouter.chat; // Resolves and caches under the first resolver.

    configureOpenRouterKey(() => 'sk-second');
    void openrouter.chat;

    expect(createOpenRouter).toHaveBeenCalledTimes(2);
    expect(createOpenRouter).toHaveBeenNthCalledWith(1, { apiKey: 'sk-first' });
    expect(createOpenRouter).toHaveBeenNthCalledWith(2, { apiKey: 'sk-second' });
  });

  it('still names the missing configuration when an injected resolver returns nothing', async () => {
    const { openrouter, configureOpenRouterKey } = await importClient();
    configureOpenRouterKey(() => undefined);

    expect(() => openrouter.chat).toThrow(/OPENROUTER_API_KEY is not set/);
  });
});
