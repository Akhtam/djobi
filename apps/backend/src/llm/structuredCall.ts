import type { ChatMessage } from '@djobi/shared';
import { generateObject, NoObjectGeneratedError, TypeValidationError } from 'ai';
import type { z } from 'zod';
import { openrouter } from './client.js';
import { routeFor, type LlmOperation } from './routing.js';

/** Options for {@link callStructured}. */
export interface StructuredToolCallOptions<Schema extends z.ZodType> {
  /** The application operation whose route policy this call uses. */
  operation: LlmOperation;
  /** Request-derived override for the operation's default output limit. */
  maxTokens?: number;
  /** The full first user-turn prompt content — the grounding scaffold and the instructions. */
  userContent: string;
  /**
   * Text placed before `userContent` in the same turn — identical across calls (e.g. the Profile
   * for every `answerQuestions` call) so the provider's implicit prefix cache can hit. Order is the
   * whole mechanism: stable first, varying last.
   */
  cachedPrefix?: string;
  /**
   * Turns after `userContent`, for `answerChat`. They start with the assistant because the
   * candidate's opening message is folded into `userContent`, keeping roles alternating.
   */
  followUpTurns?: ChatMessage[];
  /**
   * Name of the schema the model is answering with. Also the unit failures are reported against.
   */
  toolName: string;
  /** Description of the schema, shown to the model as guidance. */
  toolDescription: string;
  /** Zod schema used both to constrain generation and to validate what comes back. */
  schema: Schema;
  /**
   * An extra rule on the parsed value, checked inside the retried unit; returns the failure reason
   * or `undefined`. Failing it counts as `no-tool-call` and is retried once — unlike a schema
   * violation (`invalid-input`), which isn't.
   */
  requires?: (value: z.infer<Schema>) => string | undefined;
  /**
   * The HTTP request's signal. Passing it down stops billed generation when the candidate leaves or
   * re-analyzes.
   */
  signal?: AbortSignal | undefined;
}

/** Backend-local classification used to decide whether this exact model call may be retried. */
export type StructuredCallFailure = 'no-tool-call' | 'invalid-input';

/**
 * A structured call that produced no usable result. `no-tool-call` (no object) is retried once;
 * `invalid-input` (schema mismatch) and provider failures are not. `message` is safe for the
 * `{ error }` response.
 */
export class StructuredCallError extends Error {
  readonly kind: StructuredCallFailure;
  readonly toolName: string;
  readonly requestId?: string | undefined;
  readonly retryable: boolean;
  readonly stopReason?: string | null | undefined;

  constructor(
    kind: StructuredCallFailure,
    toolName: string,
    message: string,
    requestId?: string,
    retryable = false,
    stopReason?: string | null,
  ) {
    super(message);
    this.name = 'StructuredCallError';
    this.kind = kind;
    this.toolName = toolName;
    this.requestId = requestId;
    this.retryable = retryable;
    this.stopReason = stopReason;
  }
}

/** A value's structure without its content, for logging validation failures without PII. */
function shapeOf(value: unknown, depth = 1): unknown {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  if (depth === 0) return `object{${Object.keys(value).join(',')}}`;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, shapeOf(member, depth - 1)]),
  );
}

/** What OpenRouter reports about who actually served a request and what it cost. */
interface OpenRouterCallMetadata {
  provider?: string;
  usage?: { cost?: number };
}

function openRouterMetadata(metadata: unknown): OpenRouterCallMetadata {
  const openrouter = (metadata as Record<string, unknown> | undefined)?.openrouter;
  return (openrouter as OpenRouterCallMetadata | undefined) ?? {};
}

/**
 * Generates one object against `schema` via the provider's structured output, then validates it
 * locally. `require_parameters` keeps OpenRouter off hosts that ignore `response_format`, but the
 * local parse is the real guarantee.
 *
 * @throws {StructuredCallError} `no-tool-call` if no object was produced; `invalid-input` if it
 *   fails validation.
 */
export async function callStructured<Schema extends z.ZodType>(
  options: StructuredToolCallOptions<Schema>,
): Promise<z.infer<Schema>> {
  const route = routeFor(options.operation);
  const maxTokens = options.maxTokens ?? route.defaultMaxTokens;
  const model = openrouter.chat(route.model, {
    // Not strict mode: OpenAI's strict subset requires every property and forbids defaults, which
    // these schemas rely on. The local parse enforces shape.
    structuredOutputs: { strict: false },
  });

  const messages = [
    {
      role: 'user' as const,
      content: options.cachedPrefix
        ? `${options.cachedPrefix}\n\n${options.userContent}`
        : options.userContent,
    },
    ...(options.followUpTurns ?? []),
  ];

  const logCall = (fields: {
    attempt: 1 | 2;
    startedAt: number;
    usage?:
      | {
          inputTokens?: number | undefined;
          outputTokens?: number | undefined;
          inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
          outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
        }
      | undefined;
    finishReason?: string | undefined;
    providerMetadata?: unknown;
    requestId?: string | undefined;
  }): void => {
    const { provider, usage: openRouterUsage } = openRouterMetadata(fields.providerMetadata);
    // Sizes, counts, provider and cost only — never prompt content (it's the candidate's Profile).
    console.log('[djobi] structured_call', {
      toolName: options.toolName,
      operation: options.operation,
      model: route.model,
      provider: provider ?? null,
      effort: route.effort ?? null,
      attempt: fields.attempt,
      ms: Date.now() - fields.startedAt,
      promptChars: (options.cachedPrefix?.length ?? 0) + options.userContent.length,
      inputTokens: fields.usage?.inputTokens ?? 0,
      outputTokens: fields.usage?.outputTokens ?? 0,
      thinkingTokens: fields.usage?.outputTokenDetails?.reasoningTokens ?? 0,
      cacheReadTokens: fields.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      cost: openRouterUsage?.cost ?? null,
      finishReason: fields.finishReason ?? null,
      requestId: fields.requestId,
    });
  };

  const callOnce = async (attempt: 1 | 2): Promise<z.infer<Schema>> => {
    const startedAt = Date.now();
    try {
      const result = await generateObject({
        model,
        schema: options.schema,
        schemaName: options.toolName,
        schemaDescription: options.toolDescription,
        maxOutputTokens: maxTokens,
        messages,
        ...(options.signal ? { abortSignal: options.signal } : {}),
        // The SDK otherwise retries selected transport/status failures itself. Keep the total
        // request budget explicit here: one normal attempt, plus one semantic retry.
        maxRetries: 0,
        providerOptions: {
          openrouter: {
            provider: {
              // Skip upstream hosts that ignore `response_format`.
              require_parameters: true,
              // Prompts contain candidate profiles and application answers. Keep requests away
              // from upstreams that may retain that data, independent of account-level settings.
              data_collection: 'deny',
              // An Anthropic model slug identifies the model family, not necessarily who serves it.
              // Prefer Anthropic directly and allow only its Claude Platform on AWS as fallback.
              ...(route.model.startsWith('anthropic/')
                ? {
                    order: ['anthropic', 'claude-on-aws'],
                    only: ['anthropic', 'claude-on-aws'],
                    allow_fallbacks: true,
                  }
                : {}),
            },
            // Cost and the resolved upstream come back only when this is asked for, and they are
            // the two numbers the routing decision is meant to be revisited with.
            usage: { include: true },
            ...(route.effort ? { reasoning: { effort: route.effort } } : {}),
          },
        },
      });

      logCall({
        attempt,
        startedAt,
        usage: result.usage,
        finishReason: result.finishReason,
        providerMetadata: result.providerMetadata,
        requestId: result.response?.id,
      });

      // The AI SDK infers `result.object` through its own conditional schema type, which zod 4's
      // generic output doesn't reduce to; the SDK has already validated it against
      // `options.schema`.
      const object = result.object as z.infer<Schema>;
      const unmet = options.requires?.(object);
      if (unmet) {
        throw new StructuredCallError(
          'no-tool-call',
          options.toolName,
          `${options.toolName} produced output that failed validation: ${unmet}.`,
          result.response?.id,
          true,
          result.finishReason,
        );
      }

      return object;
    } catch (error) {
      // Anything other than "no object" (provider/transport failure, or an unmet `requires` already
      // classified above) goes to the caller unchanged.
      if (!NoObjectGeneratedError.isInstance(error)) throw error;

      const requestId = error.response?.id;
      logCall({
        attempt,
        startedAt,
        usage: error.usage,
        finishReason: error.finishReason,
        requestId,
      });

      // Output that parsed as JSON but didn't fit the schema. A second generation from the same
      // prompt almost always produces the same misreading, so this one does not get the retry.
      if (TypeValidationError.isInstance(error.cause)) {
        // Zod says which path was wrong and what it expected; without this the log never says what
        // the model actually sent, and a shape nothing normalizes yet reads as an unexplained 500.
        console.warn('[djobi] structured_call_invalid_input', {
          toolName: options.toolName,
          requestId,
          received: shapeOf(error.cause.value),
        });
        throw new StructuredCallError(
          'invalid-input',
          options.toolName,
          `${options.toolName} produced output that failed validation.`,
          requestId,
          false,
          error.finishReason,
        );
      }

      // Prose instead of an object usually succeeds on retry; running out of tokens or being
      // filtered won't.
      const retryable = error.finishReason === 'stop' || error.finishReason == null;
      throw new StructuredCallError(
        'no-tool-call',
        options.toolName,
        `${options.toolName} did not produce a structured object.`,
        requestId,
        retryable,
        error.finishReason,
      );
    }
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
      operation: options.operation,
      model: route.model,
      attempt: 2,
      maxAttempts: 2,
      firstAttemptMs: Date.now() - callStartedAt,
      requestId: error.requestId,
      stopReason: error.stopReason,
    });
    return callOnce(2);
  }
}
