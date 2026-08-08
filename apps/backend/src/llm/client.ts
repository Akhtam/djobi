import Anthropic from '@anthropic-ai/sdk';

/**
 * Shared Anthropic SDK client. Picks up credentials automatically from `ANTHROPIC_API_KEY` or an
 * `ant auth login` profile — no explicit key handling needed here.
 */
export const anthropic = new Anthropic();

/**
 * Model assignment per task: `extraction` (Haiku) is cheap and high-volume, used for the purely
 * structured `extractJob` call; `writing` (Sonnet) is used where quality matters more — resume
 * tailoring and question-answer drafting.
 */
export const MODELS = {
  extraction: 'claude-haiku-4-5',
  writing: 'claude-sonnet-5',
} as const;
