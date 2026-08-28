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
  /** Model reasoning effort, when the selected model supports it. */
  effort?: 'low' | 'medium' | 'high';
  /** The full first user-turn prompt content — the grounding scaffold and the instructions. */
  userContent: string;
  /**
   * Text placed *before* `userContent` in the same user turn, marked for prompt caching.
   *
   * For the operation that makes several calls that differ only in their tail: `answerQuestions`
   * sends one request per question, and every one of them carries the same instructions and the
   * same Profile. Without this the Profile is billed at full rate once per question; with it, the
   * first request to arrive writes the prefix and the rest read it at a tenth of the price.
   *
   * The split is by *stability*, not by size — whatever is identical across the calls goes here and
   * everything that varies stays in `userContent`, because a cached prefix only hits while it is
   * byte-identical. A prefix shorter than the model's minimum cacheable length is simply not
   * cached; it costs nothing and needs no special case here.
   */
  cachedPrefix?: string;
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
  /**
   * Aborts the request in flight — the HTTP request's own signal, which fires when the candidate's
   * browser gives up on it.
   *
   * Inference is billed and generated whether or not anyone is still waiting for it, and this
   * operation's whole cost *is* generation. A candidate who closes the panel mid-analysis, or hits
   * Re-analyze, otherwise leaves several requests running to completion for a result nothing will
   * read. Passing the signal down is what turns "the client stopped listening" into "the model
   * stopped writing".
   */
  signal?: AbortSignal;
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
 * this repository's zod/v3 schemas — see `apps/backend/README.md` for the measured comparison.
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

  const callOnce = async (attempt: 1 | 2): Promise<z.infer<Schema>> => {
    const startedAt = Date.now();
    const response = await anthropic.messages.create(
      {
        model: options.model,
        max_tokens: options.maxTokens,
        ...(options.effort ? { output_config: { effort: options.effort } } : {}),
        tools: [
          {
            name: options.toolName,
            description: options.toolDescription,
            input_schema: inputSchema,
            // The provider enforces `input_schema` during generation, so a tool call that reaches
            // this process already fits it. Without this the schema is advisory and the model picks
            // its own container when the shape is awkward — `assessRequirements` returned its `fit`
            // array double-encoded as a *string* on 3 of 3 measured calls, which is a 500 for the
            // candidate and the reason `asFitArray` exists.
            //
            // Not the structured outputs (`output_config.format`) this module's README planned for:
            // measured on the same schema, that produced the same correct shape but took 11-20s
            // against this path's 8-10s, on 1.5-2x the output tokens. A forced tool call that is
            // now schema-enforced is the same guarantee at the lower price.
            strict: true,
          },
        ],
        tool_choice: { type: 'tool', name: options.toolName },
        messages: [
          {
            role: 'user',
            content: options.cachedPrefix
              ? [
                  {
                    type: 'text' as const,
                    text: options.cachedPrefix,
                    cache_control: { type: 'ephemeral' as const },
                  },
                  { type: 'text' as const, text: options.userContent },
                ]
              : options.userContent,
          },
          ...(options.followUpTurns ?? []),
        ],
      },
      // The SDK otherwise retries selected transport/status failures itself. Keep the total request
      // budget explicit here: one normal attempt, plus one semantic retry only for no-tool-call.
      { maxRetries: 0, signal: options.signal },
    );

    // Output tokens are what a structured call spends its wall clock on — roughly 80 a second — so
    // a slow call is a long answer, not a slow network, and the two are indistinguishable without
    // this line. It is the record that says whether a latency complaint is about the prompt, the
    // number of calls, or the provider.
    const usage = response.usage as Partial<typeof response.usage> | undefined;
    // Sizes and counts only — never a character of the prompt. What it carries is the candidate's
    // Profile and the posting, and `promptChars` is here to say how big that was, not what it said.
    console.log('[djobi] structured_call', {
      toolName: options.toolName,
      model: options.model,
      effort: options.effort ?? null,
      attempt,
      ms: Date.now() - startedAt,
      promptChars: (options.cachedPrefix?.length ?? 0) + options.userContent.length,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      thinkingTokens: usage?.output_tokens_details?.thinking_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      stopReason: response.stop_reason,
      requestId: response._request_id,
    });

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

  const callStartedAt = Date.now();
  try {
    return await callOnce(1);
  } catch (error) {
    // Nobody is waiting for the answer, so a second attempt at it is pure spend. Checked before the
    // retry classification because an aborted call can surface as any of these.
    if (options.signal?.aborted) throw error;
    if (
      !(error instanceof StructuredCallError) ||
      error.kind !== 'no-tool-call' ||
      !error.retryable
    )
      throw error;

    // Including the elapsed time because this doubles the operation's latency: the caller waits for
    // a whole second call, and a run that took twice as long as usual otherwise looks unexplained.
    console.warn('[djobi] structured_call_retry', {
      kind: error.kind,
      toolName: error.toolName,
      model: options.model,
      attempt: 2,
      maxAttempts: 2,
      firstAttemptMs: Date.now() - callStartedAt,
      requestId: error.requestId,
      stopReason: error.stopReason,
    });
    return callOnce(2);
  }
}
