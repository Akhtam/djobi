import Anthropic from '@anthropic-ai/sdk';

/**
 * Shared Anthropic SDK client. Picks up credentials automatically from `ANTHROPIC_API_KEY` or an
 * `ant auth login` profile — no explicit key handling needed here.
 */
export const anthropic = new Anthropic();

/** Higher-quality model for resume rewriting, where preserving nuance matters most. */
export const MODEL = 'claude-sonnet-5';

/** Fast model for extraction, answers, and bounded, server-verified classification. */
export const FAST_MODEL = 'claude-haiku-4-5-20251001';
