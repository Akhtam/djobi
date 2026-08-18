import { describe, expect, it } from 'vitest';
import { BackendErrorBodySchema } from './wire.js';

describe('BackendErrorBodySchema', () => {
  it('accepts the backend error contract', () => {
    expect(BackendErrorBodySchema.parse({ error: 'failed' })).toEqual({ error: 'failed' });
  });

  it('rejects a non-string error', () => {
    expect(BackendErrorBodySchema.safeParse({ error: 500 }).success).toBe(false);
  });

  it('strips legacy structured-call metadata for rolling compatibility', () => {
    expect(
      BackendErrorBodySchema.parse({
        error: 'report_answers did not produce a tool call.',
        kind: 'no-tool-call',
        toolName: 'report_answers',
      }),
    ).toEqual({ error: 'report_answers did not produce a tool call.' });
  });
});
