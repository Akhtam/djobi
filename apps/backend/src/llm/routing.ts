/** Model reasoning effort, when the selected route supports it. */
export type LlmEffort = 'none' | 'low' | 'medium' | 'high';

export interface LlmRoute {
  readonly model: string;
  readonly defaultMaxTokens: number;
  readonly effort?: LlmEffort;
}

/** The complete model policy, keyed by the application operation it serves. */
export const ROUTES = {
  // 4096 rather than the 2048 a bare requirement list needs: every `stated` requirement now carries
  // a verbatim quote from the posting, so the response grows by roughly the length of the
  // requirements section itself. A truncated tool call fails validation outright, which is a worse
  // outcome than the extra tokens on a model this cheap.
  extractJob: {
    model: 'google/gemini-3.1-flash-lite',
    defaultMaxTokens: 4096,
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
  // Parsing a resume into a Profile shape, like `extractJob`, is not the "written judgement" work
  // reserved for the Claude routes above — routed to the same cheap model. The token budget is
  // higher than `extractJob`'s because a resume commonly reports several roles' worth of bullets
  // plus projects/certifications/awards in one response, where a job posting reports one role.
  extractResume: {
    model: 'google/gemini-3.1-flash-lite',
    defaultMaxTokens: 4096,
  },
} as const satisfies Record<string, LlmRoute>;

export type LlmOperation = keyof typeof ROUTES;

export function routeFor(operation: LlmOperation): LlmRoute {
  return ROUTES[operation];
}
