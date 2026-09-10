import { describe, expect, it } from 'vitest';
import { normalizeRequirementImportance } from './requirementImportance.js';
import type { JobRequirement } from './schemas.js';

const POSTING = `About the role

Requirements:
  - 5+ years of experience building distributed systems
  - Must have production Kubernetes experience
  - Strong written communication

Nice to have:
  - Familiarity with Rust`;

function requirement(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    text: 'Production Kubernetes experience',
    kind: 'unspecified',
    yearsOfExperience: null,
    importance: null,
    importanceTier: null,
    postingSignal: null,
    ...overrides,
  };
}

function normalize(one: JobRequirement): JobRequirement {
  const [only] = normalizeRequirementImportance([one], POSTING);
  return only!;
}

describe('normalizeRequirementImportance', () => {
  it('leaves a stated band alone when its quote is really in the posting', () => {
    const result = normalize(
      requirement({
        importance: 'critical',
        importanceTier: 'stated',
        postingSignal: 'Must have production Kubernetes experience',
      }),
    );

    expect(result.importance).toBe('critical');
    expect(result.importanceTier).toBe('stated');
    expect(result.postingSignal).toBe('Must have production Kubernetes experience');
  });

  it('accepts a quote that differs from the posting only in case and wrapping', () => {
    const result = normalize(
      requirement({
        importance: 'critical',
        importanceTier: 'stated',
        postingSignal: '  must have production\n  kubernetes experience  ',
      }),
    );

    expect(result.importance).toBe('critical');
    expect(result.importanceTier).toBe('stated');
  });

  it('demotes a stated band whose quote is a paraphrase, then caps it', () => {
    const result = normalize(
      requirement({
        importance: 'critical',
        importanceTier: 'stated',
        postingSignal: 'Kubernetes in production is required',
      }),
    );

    expect(result.importanceTier).toBe('inferred');
    expect(result.importance).toBe('meaningful');
    expect(result.postingSignal).toBeNull();
  });

  it('demotes a stated band that supplies no quote at all', () => {
    const result = normalize(
      requirement({ importance: 'high', importanceTier: 'stated', postingSignal: null }),
    );

    expect(result.importanceTier).toBe('inferred');
    expect(result.importance).toBe('meaningful');
  });

  it('caps an inferred critical band at meaningful', () => {
    const result = normalize(requirement({ importance: 'critical', importanceTier: 'inferred' }));

    expect(result.importance).toBe('meaningful');
  });

  it('caps an inferred high band at meaningful', () => {
    const result = normalize(requirement({ importance: 'high', importanceTier: 'inferred' }));

    expect(result.importance).toBe('meaningful');
  });

  it('treats a band with no tier as inferred, and caps it', () => {
    const result = normalize(requirement({ importance: 'critical', importanceTier: null }));

    expect(result.importanceTier).toBe('inferred');
    expect(result.importance).toBe('meaningful');
  });

  it('caps a structural band, whose section reference nothing can check', () => {
    const result = normalize(
      requirement({
        importance: 'critical',
        importanceTier: 'structural',
        postingSignal: 'listed under the Requirements heading',
      }),
    );

    expect(result.importance).toBe('meaningful');
    expect(result.importanceTier).toBe('structural');
    expect(result.postingSignal).toBe('listed under the Requirements heading');
  });

  it('leaves a structural band below the cap unchanged', () => {
    const result = normalize(
      requirement({
        importance: 'meaningful',
        importanceTier: 'structural',
        postingSignal: 'repeated in the responsibilities list',
      }),
    );

    expect(result.importance).toBe('meaningful');
  });

  it('demotes a stated band whose quote is blank, which every posting trivially contains', () => {
    const result = normalize(
      requirement({ importance: 'critical', importanceTier: 'stated', postingSignal: '   ' }),
    );

    expect(result.importanceTier).toBe('inferred');
    expect(result.importance).toBe('meaningful');
    expect(result.postingSignal).toBeNull();
  });

  it('leaves an inferred band below the cap unchanged', () => {
    const result = normalize(requirement({ importance: 'preferred', importanceTier: 'inferred' }));

    expect(result.importance).toBe('preferred');
  });

  it('returns an unassessed requirement untouched', () => {
    const unassessed = requirement();

    expect(normalize(unassessed)).toEqual(unassessed);
  });

  it('never edits the requirement itself', () => {
    const result = normalize(
      requirement({
        text: '5+ years building distributed systems',
        kind: 'required',
        yearsOfExperience: 5,
        importance: 'critical',
        importanceTier: 'inferred',
      }),
    );

    expect(result.text).toBe('5+ years building distributed systems');
    expect(result.kind).toBe('required');
    expect(result.yearsOfExperience).toBe(5);
  });

  it('normalizes every requirement in the list', () => {
    const results = normalizeRequirementImportance(
      [
        requirement({ importance: 'critical', importanceTier: 'inferred' }),
        requirement({
          importance: 'high',
          importanceTier: 'stated',
          postingSignal: 'Strong written communication',
        }),
      ],
      POSTING,
    );

    expect(results.map((entry) => entry.importance)).toEqual(['meaningful', 'high']);
  });
});
