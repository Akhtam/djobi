import { describe, expect, it } from 'vitest';
import { ROUTES, routeFor } from './routing.js';

describe('LLM routing', () => {
  it('defines policy for every model-backed operation', () => {
    expect(Object.keys(ROUTES)).toEqual([
      'extractJob',
      'tailorResume',
      'answerQuestions',
      'answerChat',
    ]);
  });

  it('owns default token limits and reasoning policy', () => {
    expect(routeFor('extractJob').defaultMaxTokens).toBe(2048);
    expect(routeFor('tailorResume')).toMatchObject({ defaultMaxTokens: 2048, effort: 'none' });
    expect(routeFor('answerQuestions').defaultMaxTokens).toBe(1024);
    expect(routeFor('answerChat').defaultMaxTokens).toBe(4096);
  });
});
