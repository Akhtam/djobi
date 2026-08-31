import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  generation,
  mockDoGenerate,
  modelCall,
  objectGeneration,
  promptText,
} from './fakeModel.js';
import { routeFor } from './routing.js';

// The seam stays exactly where it was — the module that names a provider — and only what the fake
// *is* changes: an SDK client object becomes a language model implementing the provider spec.
vi.mock('./client.js', () => import('./fakeModel.js'));

const { callStructured, StructuredCallError } = await import('./structuredCall.js');

const SampleSchema = z.object({
  title: z.string().describe('A short label'),
  count: z.number().nullable(),
  tags: z.array(z.string()),
  detail: z.object({
    note: z.string(),
  }),
});

const SAMPLE = { title: 'Hello', count: null, tags: ['a'], detail: { note: 'n' } };

const options = (overrides: Record<string, unknown> = {}) => ({
  operation: 'answerQuestions' as const,
  toolName: 'report_sample',
  toolDescription: 'Report the sample.',
  schema: SampleSchema,
  userContent: 'sample prompt',
  ...overrides,
});

describe('callStructured', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDoGenerate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('asks for the object by schema rather than through a forced tool call', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(SAMPLE));

    await expect(callStructured(options())).resolves.toEqual(SAMPLE);

    const { responseFormat, tools } = modelCall();
    expect(responseFormat).toMatchObject({ type: 'json', name: 'report_sample' });
    // Every provider takes a different JSON Schema subset, and a `$ref` is the first thing to fall
    // outside it. The schema has to arrive flat for the same reason it did under Anthropic.
    expect(JSON.stringify(responseFormat.schema)).not.toContain('$ref');
    expect(responseFormat.schema.properties.title).toMatchObject({
      type: 'string',
      description: 'A short label',
    });
    // Nothing is a tool any more: structured output is the response format, so a provider that
    // never supported forced tool calls is now reachable.
    expect(tools ?? []).toEqual([]);
  });

  it('prefers Anthropic and falls back only to Claude Platform on AWS', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(SAMPLE));

    await callStructured(options());

    expect(modelCall().providerOptions?.openrouter).toMatchObject({
      provider: {
        require_parameters: true,
        data_collection: 'deny',
        order: ['anthropic', 'claude-on-aws'],
        only: ['anthropic', 'claude-on-aws'],
        allow_fallbacks: true,
      },
      // The point of routing per operation is that the routing can be judged with numbers.
      usage: { include: true },
    });
  });

  it('uses the same schema and privacy constraints for Gemini calls', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(SAMPLE));

    await callStructured(options({ operation: 'extractJob' }));

    expect(modelCall().providerOptions?.openrouter?.provider).toEqual({
      require_parameters: true,
      data_collection: 'deny',
    });
  });

  it('sends model reasoning effort only when the operation selects one', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(SAMPLE));

    await callStructured(options({ operation: 'tailorResume' }));
    // The route owns this setting so a call site cannot silently opt into adaptive reasoning.
    expect(modelCall().providerOptions?.openrouter).toMatchObject({
      reasoning: { effort: 'none' },
    });

    mockDoGenerate.mockClear();
    await callStructured(options({ operation: 'extractJob' }));
    expect(modelCall().providerOptions?.openrouter).not.toHaveProperty('reasoning');
  });

  it('caps output tokens and leaves the retry budget to this module alone', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(SAMPLE));

    await callStructured(options({ maxTokens: 512 }));

    expect(modelCall().maxOutputTokens).toBe(512);
    // One normal attempt plus one semantic retry is the whole budget; the SDK must not add its own
    // transport retries underneath it.
    expect(mockDoGenerate).toHaveBeenCalledTimes(1);
  });

  it('logs the resolved upstream, its cost and token usage, without logging prompt content', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockDoGenerate.mockResolvedValue(
      objectGeneration(SAMPLE, {
        usage: {
          inputTokens: { total: 100, noCache: 20, cacheRead: 80, cacheWrite: 0 },
          outputTokens: { total: 40, text: 28, reasoning: 12 },
          totalTokens: 140,
        },
        response: { id: 'gen-1', modelId: routeFor('tailorResume').model },
        providerMetadata: {
          openrouter: { provider: 'Fireworks', usage: { cost: 0.00042 } },
        },
      }),
    );

    await callStructured(
      options({ operation: 'tailorResume', userContent: 'private prompt content' }),
    );

    expect(console.log).toHaveBeenCalledWith(
      '[djobi] structured_call',
      expect.objectContaining({
        toolName: 'report_sample',
        operation: 'tailorResume',
        model: routeFor('tailorResume').model,
        effort: 'none',
        // Which upstream actually served it: one slug can still be answered by several providers.
        provider: 'Fireworks',
        cost: 0.00042,
        inputTokens: 100,
        outputTokens: 40,
        thinkingTokens: 12,
        cacheReadTokens: 80,
        requestId: 'gen-1',
      }),
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      'private prompt content',
    );
  });

  // The two failures below are meaningfully different — a model that answered in prose usually
  // succeeds on a retry, one whose output didn't fit the schema usually doesn't — and telling them
  // apart is what the single retry is spent on.
  it('retries one prose answer and returns the second valid object', async () => {
    mockDoGenerate
      .mockResolvedValueOnce(generation('Sure, here you go!', { response: { id: 'gen-first' } }))
      .mockResolvedValueOnce(objectGeneration(SAMPLE));

    await expect(callStructured(options())).resolves.toMatchObject({ title: 'Hello' });
    expect(mockDoGenerate).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith('[djobi] structured_call_retry', {
      kind: 'no-tool-call',
      toolName: 'report_sample',
      operation: 'answerQuestions',
      model: routeFor('answerQuestions').model,
      attempt: 2,
      maxAttempts: 2,
      // The retry doubles the operation's latency, so what the first attempt already cost is the
      // one number that explains a run which took twice as long as usual.
      firstAttemptMs: expect.any(Number),
      requestId: 'gen-first',
      stopReason: 'stop',
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('sample prompt');
  });

  it('reports a no-object failure after exactly one retry', async () => {
    mockDoGenerate.mockResolvedValue(generation('Sure, here you go!'));

    await expect(callStructured(options())).rejects.toMatchObject({
      kind: 'no-tool-call',
      toolName: 'report_sample',
    });
    expect(mockDoGenerate).toHaveBeenCalledTimes(2);
  });

  it('reports a schema violation as invalid-input, distinct from the model not answering', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration({ title: 42, tags: 'not-an-array' }));

    const error = await callStructured(options()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StructuredCallError);
    expect(error).toMatchObject({
      kind: 'invalid-input',
      toolName: 'report_sample',
      message: 'report_sample produced output that failed validation.',
    });
    expect(String(error)).not.toContain('not-an-array');
    expect(mockDoGenerate).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalledWith(
      '[djobi] structured_call_retry',
      expect.anything(),
    );
  });

  it('retries a requirement the schema deliberately does not state, unlike a schema violation', async () => {
    // The point of the option. A rule like "this field must be non-empty" put in the schema is
    // enforced as a schema violation — non-retryable, on the reasoning that a re-generation
    // reproduces the same misreading. That reasoning is about a model that got the *shape* wrong; a
    // model that got the shape right and left one field empty usually fills it on a second attempt.
    mockDoGenerate
      .mockResolvedValueOnce(objectGeneration({ ...SAMPLE, title: '' }))
      .mockResolvedValueOnce(objectGeneration(SAMPLE));

    const result = await callStructured(
      options({ requires: (value: typeof SAMPLE) => (value.title ? undefined : 'title required') }),
    );

    expect(result).toEqual(SAMPLE);
    expect(mockDoGenerate).toHaveBeenCalledTimes(2);
  });

  it('reports an unmet requirement after the same single retry, naming what was missing', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration({ ...SAMPLE, title: '' }));

    const error = await callStructured(
      options({ requires: (value: typeof SAMPLE) => (value.title ? undefined : 'title required') }),
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({
      kind: 'no-tool-call',
      toolName: 'report_sample',
      message: 'report_sample produced output that failed validation: title required.',
    });
    expect(mockDoGenerate).toHaveBeenCalledTimes(2);
  });

  it('logs the shape of the output that failed, and never its content', async () => {
    // Zod says which path was wrong and what it expected; without the shape alongside it the log
    // never says what the model actually sent, and a deviation nothing normalizes yet — an array
    // arriving as an object — reads in production as an unexplained 500.
    mockDoGenerate.mockResolvedValue(objectGeneration({ title: 42, tags: 'not-an-array' }));

    await callStructured(options()).catch(() => undefined);

    expect(console.warn).toHaveBeenCalledWith('[djobi] structured_call_invalid_input', {
      toolName: 'report_sample',
      requestId: expect.any(String),
      received: { title: 'number', tags: 'string' },
    });
    // The output carries the candidate's profile and the posting; only its structure may be logged.
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('not-an-array');
  });

  it('names a nested container by its shape, which is the diagnosis the flat types cannot give', async () => {
    // The case the comment on `shapeOf` is written for: a field arriving as an object where an
    // array belongs. `object{…}` versus `array(n)` *is* the whole finding, and the keys are the
    // model's own field names rather than the candidate's data.
    vi.mocked(console.warn).mockClear();
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        title: { first: 'Jane', last: 'Doe' },
        tags: [{ label: 'sensitive' }, { label: 'also sensitive' }],
        note: null,
      }),
    );

    await callStructured(options()).catch(() => undefined);

    expect(console.warn).toHaveBeenCalledWith('[djobi] structured_call_invalid_input', {
      toolName: 'report_sample',
      requestId: expect.any(String),
      received: { title: 'object{first,last}', tags: 'array(2)', note: 'null' },
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('Jane');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('sensitive');
  });

  it('does not semantically retry a provider or network failure', async () => {
    const failure = new Error('connection failed');
    mockDoGenerate.mockRejectedValue(failure);

    await expect(callStructured(options())).rejects.toBe(failure);
    expect(mockDoGenerate).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(['length', 'content-filter', 'error'])(
    'does not retry a no-object response finished by %s',
    async (unified) => {
      // A `length` finish is a truncated generation: the model was writing the object and ran out
      // of budget. Retrying spends a second full generation to hit the same ceiling, so it escapes
      // as the failure it is — and `stopReason` in the log is what says to raise the limit.
      mockDoGenerate.mockResolvedValue(
        generation('{"title": "Hel', { finishReason: { unified, raw: unified } }),
      );

      await expect(callStructured(options())).rejects.toMatchObject({
        kind: 'no-tool-call',
        retryable: false,
        stopReason: unified,
      });
      expect(mockDoGenerate).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalledWith(
        '[djobi] structured_call_retry',
        expect.anything(),
      );
    },
  );
});

describe('callStructured cachedPrefix', () => {
  beforeEach(() => {
    mockDoGenerate.mockReset();
    mockDoGenerate.mockResolvedValue(objectGeneration(SAMPLE));
  });

  it('leads with the stable half so an identical prefix hits the provider cache', async () => {
    // Keep the stable text first so provider caching can recognize the byte-identical prefix.
    await callStructured(
      options({ cachedPrefix: 'the stable half', userContent: 'the varying half' }),
    );

    expect(promptText()).toBe('the stable half\n\nthe varying half');
    expect(JSON.stringify(modelCall().prompt)).not.toContain('cache_control');
  });

  it('sends the varying half alone when no prefix is given, as most callers do', async () => {
    await callStructured(options({ userContent: 'just the one turn' }));

    expect(promptText()).toBe('just the one turn');
  });

  it('keeps a conversation alternating after the scaffold turn', async () => {
    await callStructured(
      options({
        followUpTurns: [
          { role: 'assistant', content: 'a first draft' },
          { role: 'user', content: 'make it shorter' },
        ],
      }),
    );

    expect(modelCall().prompt.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });
});

describe('callStructured abort', () => {
  beforeEach(() => {
    mockDoGenerate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('hands the signal down, so giving up stops the generation rather than just the wait', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(SAMPLE));
    const controller = new AbortController();

    await callStructured(options({ signal: controller.signal }));

    expect(modelCall().abortSignal).toBe(controller.signal);
  });

  it('does not retry an abandoned call, which would spend a second request on an answer nobody wants', async () => {
    // Without the abort check this is a textbook retryable failure — no object, finished `stop` —
    // and the retry would run a whole second generation for a candidate who has closed the panel.
    mockDoGenerate.mockResolvedValue(generation('Sure!'));
    const controller = new AbortController();
    controller.abort();

    await expect(callStructured(options({ signal: controller.signal }))).rejects.toMatchObject({
      kind: 'no-tool-call',
    });

    expect(mockDoGenerate).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalledWith(
      '[djobi] structured_call_retry',
      expect.anything(),
    );
  });
});
