import Anthropic from '@anthropic-ai/sdk';

/**
 * Shared Anthropic SDK client. Picks up credentials automatically from `ANTHROPIC_API_KEY` or an
 * `ant auth login` profile — no explicit key handling needed here.
 */
export const anthropic = new Anthropic();

/**
 * The single model every LLM operation runs on. Extraction previously used a cheaper Haiku tier,
 * but at this volume the saving was fractions of a cent per job while `extractJob` grounds every
 * downstream draft — so one model it is.
 *
 * `callStructured` still takes the model per call, so a future high-volume path can opt out
 * without a refactor.
 */
export const MODEL = 'claude-sonnet-5';
