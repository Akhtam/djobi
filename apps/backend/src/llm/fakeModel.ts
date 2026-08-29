/**
 * In-memory stand-in for `client.js` — the one module that names a provider — for tests. Not
 * imported by anything that ships.
 *
 * Every LLM test needs the same three things: a language model that answers with whatever the test
 * says, a way to read the request that was built for it, and a way to spell "the model replied with
 * this object". Five test modules each rebuilding that is five chances to model the provider contract
 * slightly wrong, and the contract is not obvious — token counts are grouped rather than flat, and
 * a finish reason is an object, so a plausible-looking hand-rolled response is read as a generation
 * that used no tokens and stopped for no reason.
 *
 * It fakes the *provider*, not `callStructured`. Schema conversion, JSON parsing, validation, the
 * retry and the failure classification are the behaviour under test in `structuredCall.test.ts` and
 * the reason the other four can assert on real prompts, so the seam stays underneath all of it.
 *
 * Use it as the mock factory itself, which keeps the fake and the test looking at one module:
 *
 * ```ts
 * vi.mock('./client.js', () => import('./fakeModel.js'));
 * ```
 */
import { MockLanguageModelV4 } from 'ai/test';
import { vi } from 'vitest';

/**
 * The routing `client.ts` holds, mirrored rather than re-exported.
 *
 * Importing the real one from here would be a cycle: this module *is* the mock for `client.js`, so
 * `client.js` resolves back to this module and the import never settles. The four slugs are
 * duplicated instead, and the tests that assert which model served an operation are what notice if
 * the two ever disagree.
 */
export const MODELS = {
  extractJob: 'google/gemini-3.1-flash-lite',
  tailorResume: 'anthropic/claude-sonnet-5',
  answerQuestions: 'anthropic/claude-sonnet-5',
  answerChat: 'anthropic/claude-sonnet-5',
};

/** Every generation the code under test asks for. Reset it in `beforeEach`, as with any spy. */
export const mockDoGenerate = vi.fn();

/**
 * Stands in for the OpenRouter provider, handing out models that answer from
 * {@link mockDoGenerate}.
 *
 * `chat` is a spy because the model id is not one of the call options — it belongs to the model
 * instance, not the request — so which slug an operation routed to is only observable here.
 * `expect(openrouter.chat).toHaveBeenLastCalledWith(...)` is how a test pins a route.
 */
export const openrouter = {
  chat: vi.fn(
    (modelId: string) =>
      new MockLanguageModelV4({ provider: 'openrouter', modelId, doGenerate: mockDoGenerate }),
  ),
};

/**
 * One generation that produced `text` and nothing else.
 *
 * The defaults are the shape the provider spec actually requires: token counts grouped under
 * `inputTokens`/`outputTokens` rather than flat, and a finish reason carrying both the unified
 * value and the upstream's own. A flat `{ inputTokens: 100 }` is not rejected — it is silently read
 * as zero, which is the kind of fixture that makes a logging assertion pass for the wrong reason.
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
 * The provider-spec call options built for generation `index` — the request, as the model saw it.
 *
 * This is where a prompt assertion reads from: `.prompt` for the turns, `.responseFormat` for the
 * schema, `.providerOptions` for routing, `.maxOutputTokens` for the cap.
 */
export function modelCall(index = 0) {
  return mockDoGenerate.mock.calls[index][0];
}

/**
 * The text of one turn of generation `index`'s prompt, however the SDK chose to assemble it.
 *
 * A turn's content is an array of parts, and whether a given prompt becomes one part or several is
 * the SDK's business rather than a fact worth asserting; what the model reads is the concatenation.
 */
export function promptText(turn = 0, index = 0): string {
  const message = modelCall(index).prompt[turn];
  return (message.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
}
