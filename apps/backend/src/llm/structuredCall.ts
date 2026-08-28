import type { ChatMessage } from '@djobi/shared';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { anthropic } from './client.js';

/** Options for {@link callStructured}. */
export interface StructuredToolCallOptions<Schema extends z.ZodTypeAny> {
  /** Model id to call — normally `MODEL`. */
  model: string;
  /** Max output tokens for the request. */
  maxTokens: number;
  /** The full first user-turn prompt content — the grounding scaffold and the instructions. */
  userContent: string;
  /**
   * Conversation turns that follow the `userContent` turn, for the one operation that is a
   * conversation rather than a single request (`answerChat.ts`).
   *
   * They start with the assistant, because the candidate's opening message is folded into
   * `userContent` rather than sent after it: the Messages API rejects two consecutive turns of the
   * same role, so a scaffold turn followed by the candidate's own first turn would be a 400 from
   * the provider. Folding keeps the scaffold and the question the candidate asked in one turn, and
   * leaves the alternation the API requires intact.
   */
  followUpTurns?: ChatMessage[];
  /** Name of the tool the model is forced to call. */
  toolName: string;
  /** Description shown to the model for the forced tool. */
  toolDescription: string;
  /** Zod schema used both to build the tool's `input_schema` and to validate its `input`. */
  schema: Schema;
}

/** Backend-local classification used to decide whether this exact model call may be retried. */
export type StructuredCallFailure = 'no-tool-call' | 'invalid-input';

/**
 * A structured call that didn't produce a usable result.
 *
 * The distinction stays local to the operation that can act on it: a missing tool call gets one
 * retry, while invalid input and provider failures escape immediately. `message` remains suitable
 * for the generic `{ error }` HTTP response after the local decision has been made.
 */
export class StructuredCallError extends Error {
  constructor(
    readonly kind: StructuredCallFailure,
    readonly toolName: string,
    message: string,
    readonly requestId?: string,
    readonly retryable = false,
    readonly stopReason?: string | null,
  ) {
    super(message);
    this.name = 'StructuredCallError';
  }
}

/**
 * A value's structure with its content left out.
 *
 * The content is the candidate's Profile and the posting, so it does not belong in a log line; the
 * container is what a validation failure is actually about — `fit` arriving as an `object{…}` rather
 * than an `array(n)` is the whole diagnosis.
 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [
      key,
      Array.isArray(member)
        ? `array(${member.length})`
        : member === null
          ? 'null'
          : typeof member === 'object'
            ? `object{${Object.keys(member).join(',')}}`
            : typeof member,
    ]),
  );
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
  const inputSchema = zodToJsonSchema(options.schema, { $refStrategy: 'none' }) as never;

  const callOnce = async (): Promise<z.infer<Schema>> => {
    const response = await anthropic.messages.create(
      {
        model: options.model,
        max_tokens: options.maxTokens,
        tools: [
          {
            name: options.toolName,
            description: options.toolDescription,
            input_schema: inputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: options.toolName },
        messages: [
          { role: 'user', content: options.userContent },
          ...(options.followUpTurns ?? []),
        ],
      },
      // The SDK otherwise retries selected transport/status failures itself. Keep the total request
      // budget explicit here: one normal attempt, plus one semantic retry only for no-tool-call.
      { maxRetries: 0 },
    );

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      const retryable = response.stop_reason === 'end_turn' || response.stop_reason == null;
      throw new StructuredCallError(
        'no-tool-call',
        options.toolName,
        `${options.toolName} did not produce a tool call.`,
        response._request_id ?? undefined,
        retryable,
        response.stop_reason,
      );
    }

    const parsed = options.schema.safeParse(toolUse.input);
    if (!parsed.success) {
      // Zod says which path was wrong and what it expected; without this the log never says what the
      // model actually sent, and a shape nothing normalizes yet reads as an unexplained 500.
      console.warn('[djobi] structured_call_invalid_input', {
        toolName: options.toolName,
        requestId: response._request_id,
        received: shapeOf(toolUse.input),
      });
      throw new StructuredCallError(
        'invalid-input',
        options.toolName,
        `${options.toolName} produced input that failed validation: ${parsed.error.message}`,
        response._request_id ?? undefined,
      );
    }

    return parsed.data;
  };

  try {
    return await callOnce();
  } catch (error) {
    if (
      !(error instanceof StructuredCallError) ||
      error.kind !== 'no-tool-call' ||
      !error.retryable
    )
      throw error;

    console.warn('[djobi] structured_call_retry', {
      kind: error.kind,
      toolName: error.toolName,
      model: options.model,
      attempt: 2,
      maxAttempts: 2,
      requestId: error.requestId,
      stopReason: error.stopReason,
    });
    return callOnce();
  }
}
