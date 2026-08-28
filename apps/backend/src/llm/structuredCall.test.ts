import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  MODEL: 'claude-sonnet-5',
}));

const { callStructured, StructuredCallError } = await import('./structuredCall.js');

const SampleSchema = z.object({
  title: z.string().describe('A short label'),
  count: z.number().nullable(),
  tags: z.array(z.string()),
  detail: z.object({
    note: z.string(),
  }),
});

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_sample', input }],
  };
}

describe('callStructured', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCreate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('derives the tool input_schema from the given zod schema, flat with no $ref', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        title: 'Hello',
        count: null,
        tags: ['a'],
        detail: { note: 'n' },
      }),
    );

    await callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 1024,
      toolName: 'report_sample',
      toolDescription: 'Report the sample.',
      schema: SampleSchema,
      userContent: 'sample prompt',
    });

    const request = mockCreate.mock.calls[0][0];
    const inputSchema = request.tools[0].input_schema;

    expect(JSON.stringify(inputSchema)).not.toContain('$ref');
    expect(inputSchema.type).toBe('object');
    expect(inputSchema.properties.title).toMatchObject({
      type: 'string',
      description: 'A short label',
    });
    expect(inputSchema.properties.tags).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(inputSchema.properties.detail).toMatchObject({
      type: 'object',
      properties: { note: { type: 'string' } },
    });
    expect(inputSchema.required).toEqual(expect.arrayContaining(['title', 'tags', 'detail']));
    expect(mockCreate.mock.calls[0][1]).toEqual({ maxRetries: 0 });
  });

  it('sends model effort only when the operation selects one', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ title: 'Hello', count: null, tags: [], detail: { note: 'ok' } }),
    );

    await callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 256,
      effort: 'medium',
      toolName: 'report_sample',
      toolDescription: 'Report the sample.',
      schema: SampleSchema,
      userContent: 'sample prompt',
    });

    expect(mockCreate.mock.calls[0][0].output_config).toEqual({ effort: 'medium' });

    mockCreate.mockClear();
    await callStructured({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      toolName: 'report_sample',
      toolDescription: 'Report the sample.',
      schema: SampleSchema,
      userContent: 'sample prompt',
    });

    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('output_config');
  });

  it('logs selected effort and thinking-token usage without logging prompt content', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockCreate.mockResolvedValue({
      ...toolUseResponse({ title: 'Hello', count: null, tags: [], detail: { note: 'ok' } }),
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        output_tokens_details: { thinking_tokens: 12 },
      },
    });

    await callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 256,
      effort: 'medium',
      toolName: 'report_sample',
      toolDescription: 'Report the sample.',
      schema: SampleSchema,
      userContent: 'private prompt content',
    });

    expect(console.log).toHaveBeenCalledWith(
      '[djobi] structured_call',
      expect.objectContaining({
        effort: 'medium',
        inputTokens: 100,
        outputTokens: 40,
        thinkingTokens: 12,
      }),
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      'private prompt content',
    );
  });

  const call = () =>
    callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 1024,
      toolName: 'report_sample',
      toolDescription: 'Report the sample.',
      schema: SampleSchema,
      userContent: 'sample prompt',
    });

  // The two failures below are meaningfully different — a model that answered in prose usually
  // succeeds on a retry, one whose input didn't fit the schema usually doesn't — and telling them
  // apart used to require matching substrings of the message text.
  it('retries one prose answer and returns the second valid tool call', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Sure, here you go!' }],
        _request_id: 'req-first',
      })
      .mockResolvedValueOnce(
        toolUseResponse({ title: 'Hello', count: null, tags: [], detail: { note: 'ok' } }),
      );

    await expect(call()).resolves.toMatchObject({ title: 'Hello' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].tools[0].input_schema).toBe(
      mockCreate.mock.calls[0][0].tools[0].input_schema,
    );
    expect(console.warn).toHaveBeenCalledWith('[djobi] structured_call_retry', {
      kind: 'no-tool-call',
      toolName: 'report_sample',
      model: 'claude-sonnet-5',
      attempt: 2,
      maxAttempts: 2,
      // The retry doubles the operation's latency, so what the first attempt already cost is the
      // one number that explains a run which took twice as long as usual.
      firstAttemptMs: expect.any(Number),
      requestId: 'req-first',
      stopReason: undefined,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('sample prompt');
  });

  it('reports a no-tool-call failure after exactly one retry', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Sure, here you go!' }] });

    await expect(call()).rejects.toMatchObject({
      kind: 'no-tool-call',
      toolName: 'report_sample',
      message: 'report_sample did not produce a tool call.',
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('reports a schema violation as invalid-input, distinct from the model not calling the tool', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ title: 42, tags: 'not-an-array' }));

    const error = await call().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StructuredCallError);
    expect(error).toMatchObject({ kind: 'invalid-input', toolName: 'report_sample' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalledWith(
      '[djobi] structured_call_retry',
      expect.anything(),
    );
  });

  it('logs the shape of the input that failed, and never its content', async () => {
    // Zod says which path was wrong and what it expected; without the shape alongside it the log
    // never says what the model actually sent, and a deviation nothing normalizes yet — an array
    // arriving as an object — reads in production as an unexplained 500.
    mockCreate.mockResolvedValue(toolUseResponse({ title: 42, tags: 'not-an-array' }));

    await call().catch(() => undefined);

    expect(console.warn).toHaveBeenCalledWith('[djobi] structured_call_invalid_input', {
      toolName: 'report_sample',
      requestId: undefined,
      received: { title: 'number', tags: 'string' },
    });
    // The input carries the candidate's profile and the posting; only its structure may be logged.
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('not-an-array');
  });

  it('does not semantically retry an SDK or network failure', async () => {
    const failure = new Error('connection failed');
    mockCreate.mockRejectedValue(failure);

    await expect(call()).rejects.toBe(failure);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(['max_tokens', 'refusal', 'pause_turn'])(
    'does not retry a no-tool response stopped by %s',
    async (stopReason) => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'No tool call' }],
        stop_reason: stopReason,
      });

      await expect(call()).rejects.toMatchObject({
        kind: 'no-tool-call',
        retryable: false,
        stopReason,
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );
});

describe('callStructured cachedPrefix', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('sends the prefix as its own cache-marked block ahead of the varying half', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ title: 'Hello', count: null, tags: [], detail: { note: 'ok' } }),
    );

    await callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 256,
      toolName: 'report_sample',
      toolDescription: 'a sample tool',
      schema: SampleSchema,
      cachedPrefix: 'the stable half',
      userContent: 'the varying half',
    });

    expect(mockCreate.mock.calls[0][0].messages[0].content).toEqual([
      { type: 'text', text: 'the stable half', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'the varying half' },
    ]);
  });

  it('sends a plain string when no prefix is given, as every other caller does', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ title: 'Hello', count: null, tags: [], detail: { note: 'ok' } }),
    );

    await callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 256,
      toolName: 'report_sample',
      toolDescription: 'a sample tool',
      schema: SampleSchema,
      userContent: 'just the one block',
    });

    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe('just the one block');
  });
});

describe('callStructured abort', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('hands the signal to the SDK, so giving up stops the generation rather than just the wait', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ title: 'Hello', count: null, tags: [], detail: { note: 'ok' } }),
    );
    const controller = new AbortController();

    await callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 256,
      toolName: 'report_sample',
      toolDescription: 'a sample tool',
      schema: SampleSchema,
      userContent: 'sample prompt',
      signal: controller.signal,
    });

    expect(mockCreate.mock.calls[0][1]).toEqual({ maxRetries: 0, signal: controller.signal });
  });

  it('does not retry an abandoned call, which would spend a second request on an answer nobody wants', async () => {
    // Without the abort check this is a textbook retryable failure — no tool call, `end_turn` — and
    // the retry would run a whole second generation for a candidate who has already closed the panel.
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Sure!' }],
      stop_reason: 'end_turn',
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      callStructured({
        model: 'claude-sonnet-5',
        maxTokens: 256,
        toolName: 'report_sample',
        toolDescription: 'a sample tool',
        schema: SampleSchema,
        userContent: 'sample prompt',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'no-tool-call' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalledWith(
      '[djobi] structured_call_retry',
      expect.anything(),
    );
  });

  it('marks the forced tool strict, so the schema binds generation instead of advising it', async () => {
    // Without this the model picks its own container when a shape is awkward: `assessRequirements`
    // returned its `fit` array double-encoded as a string on 3 of 3 measured calls.
    mockCreate.mockResolvedValue(
      toolUseResponse({ title: 'Hello', count: null, tags: [], detail: { note: 'ok' } }),
    );

    await callStructured({
      model: 'claude-sonnet-5',
      maxTokens: 256,
      toolName: 'report_sample',
      toolDescription: 'a sample tool',
      schema: SampleSchema,
      userContent: 'sample prompt',
    });

    expect(mockCreate.mock.calls[0][0].tools[0].strict).toBe(true);
  });
});
