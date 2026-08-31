import { createOpenRouter } from '@openrouter/ai-sdk-provider';

/**
 * Shared OpenRouter provider. One key and one meter for every model, whoever serves it.
 *
 * `OPENROUTER_API_KEY` replaces `ANTHROPIC_API_KEY`: routing per operation means several vendors,
 * and a key per vendor would be several bills to reconcile against one candidate's run.
 */
export const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
