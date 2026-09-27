/**
 * Test stand-in for `client.js`: a provider whose models answer as the test says, with helpers to
 * read the built request. It fakes the *provider*, not `callStructured`, so schema conversion,
 * parsing, validation and retries stay under test. Use as the mock factory:
 *
 * ```ts
 * vi.mock('./client.js', () => import('./fakeModel.js'));
 * ```
 */
import { MockLanguageModelV4 } from 'ai/test';
import { vi } from 'vitest';

/** Every generation the code under test asks for. Reset it in `beforeEach`, as with any spy. */
export const mockDoGenerate = vi.fn();

/**
 * Fake OpenRouter provider. `chat` is a spy because the routed model id is only visible here:
 * `expect(openrouter.chat).toHaveBeenLastCalledWith(...)` pins a route.
 */
export const openrouter = {
  chat: vi.fn(
    (modelId: string) =>
      new MockLanguageModelV4({ provider: 'openrouter', modelId, doGenerate: mockDoGenerate }),
  ),
};

/**
 * One generation returning `text`. Defaults follow the provider spec: grouped token counts and a
 * `{ unified, raw }` finish reason (a flat shape is silently read as zero).
 */
export function generation(text: string, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 40, text: 40, reasoning: 0 },
      totalTokens: 140,
    },
    warnings: [],
    ...overrides,
  };
}

/** One generation carrying `object` as JSON — what a structured call is asking the model for. */
export function objectGeneration(object: unknown, overrides: Record<string, unknown> = {}) {
  return generation(JSON.stringify(object), overrides);
}

/**
 * The call options for generation `index`: `.prompt`, `.responseFormat`, `.providerOptions`,
 * `.maxOutputTokens`.
 */
export function modelCall(index = 0) {
  const call = mockDoGenerate.mock.calls[index];
  if (!call)
    throw new Error(
      `Expected model call #${index}, but only ${mockDoGenerate.mock.calls.length} were made.`,
    );
  return call[0];
}

/** The concatenated text of one prompt turn, however the SDK split it into parts. */
export function promptText(turn = 0, index = 0): string {
  const message = modelCall(index).prompt[turn];
  return (message.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
}
