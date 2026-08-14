import type { StructuredCallFailure } from '@djobi/shared';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
  /** Zod schema used both to build the tool's `input_schema` and to validate its `input`. */
  schema: Schema;
}

/**
 * A structured call that didn't produce a usable result.
 *
 * The distinction above used to exist only inside the two message strings, and those strings were
 * the entire interface: they were thrown, flattened into `{ error }` by `app.ts`, dug back out by
 * `callBackend`'s `reasonFrom`, re-wrapped with a status prefix, stored on the run, and rendered
 * verbatim in the panel — six modules, and asserted verbatim across both packages' test suites.
 * Nothing anywhere could tell the retryable case from the non-retryable one without matching on
 * substrings of English. `message` is unchanged so what the user reads stays the same; `kind` is
 * what anything downstream should branch on.
 */
export class StructuredCallError extends Error {
  constructor(
    readonly kind: StructuredCallFailure,
    readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = 'StructuredCallError';
  }
}

/**
 * Forces the model to call a single tool and validates its input against the given zod schema.
 * Used instead of `output_config.format` / `messages.parse()`, which aren't available in the
 * installed `@anthropic-ai/sdk` version (0.68.0) — see `apps/backend/README.md` for why.
 *
 * @param options - See {@link StructuredToolCallOptions}.
 * @returns The tool call's `input`, validated and typed against `options.schema`.
 * @throws {StructuredCallError} If the model doesn't return a tool call (`kind: 'no-tool-call'`),
 *   or the tool call's input fails validation (`kind: 'invalid-input'`).
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
        input_schema: zodToJsonSchema(options.schema, { $refStrategy: 'none' }) as never,
      },
    ],
    tool_choice: { type: 'tool', name: options.toolName },
    messages: [{ role: 'user', content: options.userContent }],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new StructuredCallError(
      'no-tool-call',
      options.toolName,
      `${options.toolName} did not produce a tool call.`,
    );
  }

  const parsed = options.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new StructuredCallError(
      'invalid-input',
      options.toolName,
      `${options.toolName} produced input that failed validation: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
