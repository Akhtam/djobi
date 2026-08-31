/** Model reasoning effort, when the selected route supports it. */
export type LlmEffort = 'none' | 'low' | 'medium' | 'high';

export interface LlmRoute {
  readonly model: string;
  readonly defaultMaxTokens: number;
  readonly effort?: LlmEffort;
}

/** The complete model policy, keyed by the application operation it serves. */
export const ROUTES = {
  extractJob: {
    model: 'google/gemini-3.1-flash-lite',
    defaultMaxTokens: 2048,
  },
  tailorResume: {
    model: 'anthropic/claude-sonnet-5',
    defaultMaxTokens: 2048,
    effort: 'none',
  },
  answerQuestions: {
    model: 'anthropic/claude-sonnet-5',
    defaultMaxTokens: 1024,
  },
  answerChat: {
    model: 'anthropic/claude-sonnet-5',
    defaultMaxTokens: 4096,
  },
} as const satisfies Record<string, LlmRoute>;

export type LlmOperation = keyof typeof ROUTES;

export function routeFor(operation: LlmOperation): LlmRoute {
  return ROUTES[operation];
}
