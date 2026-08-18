import { describe, expect, it } from 'vitest';
import { ProfileSchema } from './schemas.js';
import { BackendErrorBodySchema, SaveProfileRequestSchema } from './wire.js';

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

describe('SaveProfileRequestSchema', () => {
  // The alias exists so `/profile` has a named body like every other route. If it ever stops being
  // the Profile itself, the extension's `saveProfile` is sending something the route won't store.
  it('is the Profile schema', () => {
    const profile = ProfileSchema.parse({
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: null,
      location: null,
      links: { linkedin: null, portfolio: null, github: null },
      workExperience: [],
      education: [],
      skills: [],
      stories: [],
      screeningAnswers: {},
      customAnswers: [],
    });

    expect(SaveProfileRequestSchema.parse(profile)).toEqual(profile);
  });

  it('rejects a body that is not a Profile', () => {
    expect(SaveProfileRequestSchema.safeParse({ fullName: 42 }).success).toBe(false);
  });
});
