import type { ChatMessage } from '@djobi/shared';
import { generateObject, NoObjectGeneratedError, TypeValidationError } from 'ai';
import type { z } from 'zod';
import { openrouter } from './client.js';

/** Options for {@link callStructured}. */
export interface StructuredToolCallOptions<Schema extends z.ZodTypeAny> {
  /** Model id to call — an OpenRouter slug, normally read from `MODELS`. */
  model: string;
  /** Max output tokens for the request. */
  maxTokens: number;
  /** Model reasoning effort, when the selected model supports it. */
  effort?: 'none' | 'low' | 'medium' | 'high';
  /** The full first user-turn prompt content — the grounding scaffold and the instructions. */
  userContent: string;
  /**
   * Text placed *before* `userContent` in the same user turn, so the provider can cache it.
   *
   * For the operation that makes several calls that differ only in their tail: `answerQuestions`
   * sends one request per question, and every one of them carries the same instructions and the
   * same Profile. Without this the Profile is billed at full rate once per question.
   *
   * There is no marker to send. The models this routes to cache implicitly, on a byte-identical
   * leading prefix, so the option means exactly what it always meant — stable text first, varying
   * text last — and that ordering *is* the whole mechanism. Two things follow from implicit
   * caching that did not hold under an explicit one: there is no cache *write* premium, so a
   * concurrent first wave of requests no longer all pay to author the prefix; and a prefix shorter
   * than the provider's minimum is simply not cached, costing nothing.
   *
   * The split is by *stability*, not by size — whatever is identical across the calls goes here and
   * everything that varies stays in `userContent`, because a cached prefix only hits while it is
   * byte-identical.
   */
  cachedPrefix?: string;
  /**
   * Conversation turns that follow the `userContent` turn, for the one operation that is a
   * conversation rather than a single request (`answerChat.ts`).
   *
   * They start with the assistant, because the candidate's opening message is folded into
   * `userContent` rather than sent after it: two consecutive turns of the same role are rejected by
   * some providers and silently merged by others. Folding keeps the scaffold and the question the
   * candidate asked in one turn, and leaves the alternation intact for every upstream.
   */
  followUpTurns?: ChatMessage[];
  /** Name of the schema the model is answering with. Also the unit failures are reported against. */
  toolName: string;
  /** Description of the schema, shown to the model as guidance. */
  toolDescription: string;
  /** Zod schema used both to constrain generation and to validate what comes back. */
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
 * The distinction stays local to the operation that can act on it: a model that answered with
 * something that isn't the object gets one retry, while output that parsed but didn't fit the
 * schema, and provider failures, escape immediately. `message` remains suitable for the generic
 * `{ error }` HTTP response after the local decision has been made.
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
 * Generates one object against the given zod schema, validated before it is returned.
 *
 * Structured output is the provider's own mechanism rather than a forced tool call, so which
 * upstream serves the request now matters: OpenRouter's schema support varies by model *and* by
 * host, and a request that lands on a host ignoring `response_format` comes back as prose.
 * `require_parameters` makes those hosts ineligible — but the guarantee is still the local parse,
 * not the provider's promise, which is why the schema is re-validated and the retry stays here.
 *
 * @param options - See {@link StructuredToolCallOptions}.
 * @returns The generated object, validated and typed against `options.schema`.
 * @throws {StructuredCallError} If the model doesn't produce the object at all
 *   (`kind: 'no-tool-call'`), or produces one that fails validation (`kind: 'invalid-input'`).
 */
export async function callStructured<Schema extends z.ZodTypeAny>(
  options: StructuredToolCallOptions<Schema>,
): Promise<z.infer<Schema>> {
  const model = openrouter.chat(options.model, {
    // Strict mode is OpenAI's JSON Schema subset — every property required, no defaults — and these
    // schemas are not written in it: an omitted `revisedAnswer` and a defaulted `note` are both
    // meaningful. It was Anthropic's forced-tool guarantee that needed it; here the schema is the
    // response format and the local parse is what enforces the shape.
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
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: { cacheReadTokens?: number };
      outputTokenDetails?: { reasoningTokens?: number };
    };
    finishReason?: string;
    providerMetadata?: unknown;
    requestId?: string;
  }): void => {
    const { provider, usage: openRouterUsage } = openRouterMetadata(fields.providerMetadata);
    // Output tokens are what a structured call spends its wall clock on, so a slow call is a long
    // answer rather than a slow network. `provider` and `cost` are what make the routing arguable
    // with numbers instead of opinions: one slug can be served by any of seventeen upstreams, and
    // "which model should do this" is not answerable without knowing what each one actually cost.
    //
    // Sizes and counts only — never a character of the prompt. What it carries is the candidate's
    // Profile and the posting, and `promptChars` is here to say how big that was, not what it said.
    console.log('[djobi] structured_call', {
      toolName: options.toolName,
      model: options.model,
      provider: provider ?? null,
      effort: options.effort ?? null,
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
        maxOutputTokens: options.maxTokens,
        messages,
        abortSignal: options.signal,
        // The SDK otherwise retries selected transport/status failures itself. Keep the total
        // request budget explicit here: one normal attempt, plus one semantic retry.
        maxRetries: 0,
        providerOptions: {
          openrouter: {
            provider: {
              // Structured-output support varies by upstream as well as by model, and a host that
              // ignores `response_format` turns every call into a no-object failure. This is what
              // keeps the request off those hosts in the first place.
              require_parameters: true,
              // Prompts contain candidate profiles and application answers. Keep requests away
              // from upstreams that may retain that data, independent of account-level settings.
              data_collection: 'deny',
              // An Anthropic model slug identifies the model family, not necessarily who serves it.
              // Prefer Anthropic directly and allow only its Claude Platform on AWS as fallback.
              ...(options.model.startsWith('anthropic/')
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
            ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
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

      return result.object;
    } catch (error) {
      // Anything that isn't "the model didn't give us the object" is a provider or transport
      // failure, and belongs to the caller unchanged.
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

      // A model that answered in prose usually gets it right on a second try. A generation that ran
      // out of tokens, was filtered, or errored will not: the retry would spend a whole second
      // generation reaching the same ceiling, and `finishReason` in the log is what says so.
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
