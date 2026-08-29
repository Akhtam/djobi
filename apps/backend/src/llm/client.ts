import { createOpenRouter } from '@openrouter/ai-sdk-provider';

/**
 * Shared OpenRouter provider. One key and one meter for every model, whoever serves it.
 *
 * `OPENROUTER_API_KEY` replaces `ANTHROPIC_API_KEY`: routing per operation means several vendors,
 * and a key per vendor would be several bills to reconcile against one candidate's run.
 */
export const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

/** The four operations that call a model. The unit routing is decided in, and logged against. */
export type LlmOperation = 'extractJob' | 'tailorResume' | 'answerQuestions' | 'answerChat';

/**
 * Which model serves each operation, as OpenRouter slugs.
 *
 * This map is the whole of the routing policy, deliberately: a tier split across one vendor's
 * models (`MODEL`/`FAST_MODEL`) stopped meaning anything once the models come from several, and
 * "which model does the tailoring" became a question worth answering per operation. Changing a
 * route — including putting one back on `anthropic/claude-*`, which OpenRouter also serves — is an
 * edit to this object and nothing else.
 *
 * The slugs are exact and verified against OpenRouter's model list. A wrong slug is a 404 at
 * request time rather than a type error, so they are pinned here rather than composed anywhere.
 */
export const MODELS: Record<LlmOperation, string> = {
  // Highest call volume in the app — every job, every Log-tab entry — and the serial gate the rest
  // of the Analysis Step waits behind. The task is transcription from text already in front of it.
  extractJob: 'google/gemini-3.1-flash-lite',
  // The one call where nuance is the product.
  tailorResume: 'anthropic/claude-sonnet-5',
  // Freeform prose grounded in Stories — the same judgement as tailoring.
  answerQuestions: 'anthropic/claude-sonnet-5',
  // The same drafting task as `answerQuestions`, in a conversation.
  answerChat: 'anthropic/claude-sonnet-5',
};
