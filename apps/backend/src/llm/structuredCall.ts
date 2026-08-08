import type { z } from 'zod';
import { anthropic } from './client.js';

/** Options for {@link callStructured}. */
export interface StructuredToolCallOptions<Schema extends z.ZodTypeAny> {
  /** Model id to call, e.g. `MODELS.extraction` or `MODELS.writing`. */
  model: string;
  /** Max output tokens for the request. */
  maxTokens: number;
  /** The full user-turn prompt content. */
  userContent: string;
  /** Name of the tool the model is forced to call. */
  toolName: string;
  /** Description shown to the model for the forced tool. */
  toolDescription: string;
  /** JSON Schema for the tool's `input` — hand-maintained to mirror `schema`. */
  inputSchema: Record<string, unknown>;
  /** Zod schema used to validate the tool call's `input` before returning it. */
  schema: Schema;
}

/**
 * Forces the model to call a single tool and validates its input against the given zod schema.
 * Used instead of `output_config.format` / `messages.parse()`, which aren't available in the
 * installed `@anthropic-ai/sdk` version (0.68.0) — see `apps/backend/README.md` for why.
 *
 * @param options - See {@link StructuredToolCallOptions}.
 * @returns The tool call's `input`, validated and typed against `options.schema`.
 * @throws If the model doesn't return a tool call, or the tool call's input fails validation.
 */
export async function callStructured<Schema extends z.ZodTypeAny>(
  options: StructuredToolCallOptions<Schema>,
): Promise<z.infer<Schema>> {
  const response = await anthropic.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    tools: [
      {
        name: options.toolName,
        description: options.toolDescription,
        input_schema: options.inputSchema as never,
      },
    ],
    tool_choice: { type: 'tool', name: options.toolName },
    messages: [{ role: 'user', content: options.userContent }],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`${options.toolName} did not produce a tool call.`);
  }

  const parsed = options.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `${options.toolName} produced input that failed validation: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
