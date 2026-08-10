import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  MODELS: { extraction: 'claude-haiku-4-5', writing: 'claude-sonnet-5' },
}));

const { callStructured } = await import('./structuredCall.js');

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
    mockCreate.mockReset();
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
      model: 'claude-haiku-4-5',
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
  });
});
