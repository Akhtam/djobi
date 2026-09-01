import { describe, expect, it } from 'vitest';
import type { Application, JobKeyword, JobRequirement } from '@djobi/shared';
import {
  DEFAULT_RANGE,
  RANGES,
  keywordFrequency,
  rangeStart,
  requirementKindCounts,
  yearsOfExperienceDistribution,
} from './analytics';

function requirement(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return { text: 'Some requirement', kind: 'unspecified', yearsOfExperience: null, ...overrides };
}

function keyword(overrides: Partial<JobKeyword> = {}): JobKeyword {
  return { term: 'TypeScript', category: null, ...overrides };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: `app-${Math.random().toString(36).slice(2, 8)}`,
    company: 'Acme',
    roleTitle: 'Engineer',
    jobUrl: 'https://acme.com/jobs/1',
    createdAt: '2026-03-01T00:00:00.000Z',
    source: 'autofill',
    stage: 'applied',
    jobInfo: {
      company: 'Acme',
      team: null,
      roleTitle: 'Engineer',
      seniority: null,
      location: null,
      requirements: [],
      keywords: [],
    },
    tailoredResume: { skills: [], workExperience: [] },
    answers: [],
    notes: [],
    ...overrides,
  };
}

describe('RANGES / DEFAULT_RANGE', () => {
  it('is the closed set the URL and the range control both read from', () => {
    expect(RANGES).toEqual(['7d', '14d', '30d', '60d']);
  });

  it('defaults to 7 days', () => {
    expect(DEFAULT_RANGE).toBe('7d');
  });
});

describe('rangeStart', () => {
  it('returns local midnight of today for a 1-day-equivalent boundary check', () => {
    const today = new Date(2026, 2, 15, 14, 30); // 2026-03-15 14:30 local
    const start = rangeStart('7d', today);

    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  it('is inclusive of today, so a 7-day range spans seven calendar days total', () => {
    const today = new Date(2026, 2, 15);
    const start = rangeStart('7d', today);

    // today (15th) minus 6 days = 9th — seven days: 9,10,11,12,13,14,15.
    expect(start).toEqual(new Date(2026, 2, 9));
  });

  it('spans the right number of days for every range', () => {
    const today = new Date(2026, 5, 30);
    expect(rangeStart('14d', today)).toEqual(new Date(2026, 5, 17));
    expect(rangeStart('30d', today)).toEqual(new Date(2026, 5, 1));
    expect(rangeStart('60d', today)).toEqual(new Date(2026, 4, 2));
  });

  it('crosses a month boundary correctly', () => {
    const today = new Date(2026, 2, 3); // March 3rd
    expect(rangeStart('7d', today)).toEqual(new Date(2026, 1, 25)); // Feb 25
  });
});

describe('keywordFrequency', () => {
  it('counts postings that asked, not mentions — a repeated keyword within one posting counts once', () => {
    const applications = [
      application({ jobInfo: { ...application().jobInfo, keywords: [keyword(), keyword()] } }),
    ];

    expect(keywordFrequency(applications)).toEqual([
      { term: 'TypeScript', category: null, count: 1 },
    ]);
  });

  it('groups by normalizeLabel, so a case/whitespace variant does not split into a second row', () => {
    const applications = [
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'typescript' })] },
      }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'TypeScript' })] },
      }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'TypeScript' })] },
      }),
    ];

    const rows = keywordFrequency(applications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ term: 'TypeScript', category: null, count: 3 });
  });

  it('displays the most frequent original spelling within a normalized group', () => {
    const applications = [
      application({ jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'K8s' })] } }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'Kubernetes' })] },
      }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'Kubernetes' })] },
      }),
    ];

    expect(keywordFrequency(applications)[0].term).toBe('Kubernetes');
  });

  it('carries the most frequent non-null category along with the term', () => {
    const applications = [
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ category: 'language' })] },
      }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ category: 'language' })] },
      }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ category: null })] },
      }),
    ];

    expect(keywordFrequency(applications)[0].category).toBe('language');
  });

  it('sorts by count descending, alphabetical tie-break', () => {
    const applications = [
      application({ jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'Zig' })] } }),
      application({ jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'Ada' })] } }),
      application({
        jobInfo: {
          ...application().jobInfo,
          keywords: [keyword({ term: 'Rust' }), keyword({ term: 'Rust' })],
        },
      }),
    ];
    // Rust appears in one posting alongside itself twice — still one posting's worth — so all
    // three terms tie at count 1 and fall back to alphabetical order.

    expect(keywordFrequency(applications).map((row) => row.term)).toEqual(['Ada', 'Rust', 'Zig']);
  });

  it('skips a blank keyword rather than reporting a row for it', () => {
    const applications = [
      application({ jobInfo: { ...application().jobInfo, keywords: [keyword({ term: '  ' })] } }),
    ];

    expect(keywordFrequency(applications)).toEqual([]);
  });

  it('returns nothing for no applications', () => {
    expect(keywordFrequency([])).toEqual([]);
  });
});

describe('requirementKindCounts', () => {
  it('counts every kind explicitly, unspecified included, rather than deriving it from a total', () => {
    const applications = [
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [
            requirement({ kind: 'required' }),
            requirement({ kind: 'required' }),
            requirement({ kind: 'preferred' }),
            requirement({ kind: 'unspecified' }),
          ],
        },
      }),
    ];

    expect(requirementKindCounts(applications)).toEqual({
      required: 2,
      preferred: 1,
      unspecified: 1,
      total: 4,
    });
  });

  it('returns all zeros for no requirements, not a division-by-zero artifact', () => {
    expect(requirementKindCounts([application()])).toEqual({
      required: 0,
      preferred: 0,
      unspecified: 0,
      total: 0,
    });
  });
});

describe('yearsOfExperienceDistribution', () => {
  it('counts only requirements that state a figure, ascending by years', () => {
    const applications = [
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [
            requirement({ yearsOfExperience: 5 }),
            requirement({ yearsOfExperience: null }),
            requirement({ yearsOfExperience: 3 }),
            requirement({ yearsOfExperience: 5 }),
          ],
        },
      }),
    ];

    expect(yearsOfExperienceDistribution(applications)).toEqual([
      { years: 3, count: 1 },
      { years: 5, count: 2 },
    ]);
  });

  it('returns nothing when no requirement states a figure', () => {
    const applications = [
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [requirement({ yearsOfExperience: null })],
        },
      }),
    ];

    expect(yearsOfExperienceDistribution(applications)).toEqual([]);
  });
});
