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
    expect(console.warn).not.toHaveBeenCalled();
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
