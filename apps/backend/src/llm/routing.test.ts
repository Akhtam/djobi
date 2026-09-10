import { describe, expect, it } from 'vitest';
import { ROUTES, routeFor } from './routing.js';

describe('LLM routing', () => {
  it('defines policy for every model-backed operation', () => {
    expect(Object.keys(ROUTES)).toEqual([
      'extractJob',
      'tailorResume',
      'answerQuestions',
      'answerChat',
      'extractResume',
    ]);
  });

  it('owns default token limits and reasoning policy', () => {
    expect(routeFor('extractJob').defaultMaxTokens).toBe(4096);
    expect(routeFor('tailorResume')).toMatchObject({ defaultMaxTokens: 2048, effort: 'none' });
    expect(routeFor('answerQuestions').defaultMaxTokens).toBe(1024);
    expect(routeFor('answerChat').defaultMaxTokens).toBe(4096);
    expect(routeFor('extractResume')).toMatchObject({
      model: 'google/gemini-3.1-flash-lite',
      defaultMaxTokens: 4096,
    });
  });
});
