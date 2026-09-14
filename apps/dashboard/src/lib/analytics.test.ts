import { describe, expect, it } from 'vitest';
import type {
  Application,
  JobKeyword,
  JobRequirement,
  RequirementEvidenceEntry,
} from '@djobi/shared';
import {
  DEFAULT_RANGE,
  MIN_DECIDED_FOR_RATE,
  RANGES,
  analyticsReport,
  coverageForKeywords,
  evidenceByRequirement,
  groupByKeywordCategory,
  keywordCoverageSummary,
  keywordFrequency,
  keywordRows,
  outcomeOf,
  rangeStart,
  requirementEvidenceRollup,
  requirementKindCounts,
  requirementsReport,
  responseRate,
  requirementImportanceCounts,
  yearsOfExperienceDistribution,
} from './analytics';
import { fixtureProfile } from './fixtures';
import type { KeywordFrequencyRow } from './analytics';

function frequencyRow(overrides: Partial<KeywordFrequencyRow> = {}): KeywordFrequencyRow {
  return { term: 'TypeScript', category: null, count: 1, ...overrides };
}

function requirement(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    text: 'Some requirement',
    kind: 'unspecified',
    yearsOfExperience: null,
    importance: null,
    importanceTier: null,
    postingSignal: null,
    ...overrides,
  };
}

function keyword(overrides: Partial<JobKeyword> = {}): JobKeyword {
  return { term: 'TypeScript', category: null, postingSpelling: null, ...overrides };
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
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
    ...overrides,
  };
}

describe('RANGES / DEFAULT_RANGE', () => {
  it('is the closed set the URL and the range control both read from', () => {
    expect(RANGES).toEqual(['7d', '14d', '30d', '60d', 'all']);
  });

  it('defaults to 14 days', () => {
    expect(DEFAULT_RANGE).toBe('14d');
  });
});

describe('rangeStart', () => {
  it('returns local midnight of today for a 1-day-equivalent boundary check', () => {
    const today = new Date(2026, 2, 15, 14, 30); // 2026-03-15 14:30 local
    const start = rangeStart('7d', today)!;

    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  // `null`, not a date far enough back to include everything: the view renders this boundary, so a
  // sentinel would print as a claim that the search began then.
  it('names no boundary at all for the all-time range', () => {
    expect(rangeStart('all', new Date(2026, 2, 15))).toBeNull();
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

  it('groups by normalizeKeyword, so a case/whitespace variant does not split into a second row', () => {
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

  it('groups space and dash variants into one keyword row', () => {
    const applications = [
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'Full Stack' })] },
      }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'Full-stack' })] },
      }),
      application({
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'full stack' })] },
      }),
    ];

    expect(keywordFrequency(applications)).toEqual([
      { term: 'Full Stack', category: null, count: 3 },
    ]);
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

    expect(keywordFrequency(applications)[0]!.term).toBe('Kubernetes');
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

    expect(keywordFrequency(applications)[0]!.category).toBe('language');
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

describe('requirementImportanceCounts', () => {
  it('counts each band, and the unassessed on their own line', () => {
    const applications = [
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [
            requirement({ text: 'a', importance: 'critical' }),
            requirement({ text: 'b', importance: 'critical' }),
            requirement({ text: 'c', importance: 'low-signal' }),
            requirement({ text: 'd' }),
          ],
        },
      }),
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [requirement({ text: 'e', importance: 'high' })],
        },
      }),
    ];

    expect(requirementImportanceCounts(applications)).toEqual({
      critical: 2,
      high: 1,
      meaningful: 0,
      preferred: 0,
      'low-signal': 1,
      unbanded: 1,
      total: 5,
    });
  });

  it('counts a wholly unassessed history as unbanded rather than as a low band', () => {
    const applications = [
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [requirement({ text: 'a' }), requirement({ text: 'b' })],
        },
      }),
    ];
    const counts = requirementImportanceCounts(applications);

    expect(counts.unbanded).toBe(2);
    expect(counts['low-signal']).toBe(0);
    expect(counts.total).toBe(2);
  });

  it('counts nothing for an empty range', () => {
    expect(requirementImportanceCounts([]).total).toBe(0);
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

  it('counts explicit years in legacy requirement text when the structured field is absent', () => {
    const applications = [
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [
            requirement({ text: '3+ years building production systems' }),
            requirement({ text: 'At least 3 years of TypeScript experience' }),
            requirement({ text: 'Between 5-7 years of backend experience' }),
          ],
        },
      }),
    ];

    expect(yearsOfExperienceDistribution(applications)).toEqual([
      { years: 3, count: 2 },
      { years: 5, count: 1 },
    ]);
  });

  it('does not count a structured threshold again when the text repeats it', () => {
    const applications = [
      application({
        jobInfo: {
          ...application().jobInfo,
          requirements: [
            requirement({ text: '5+ years of backend experience', yearsOfExperience: 5 }),
          ],
        },
      }),
    ];

    expect(yearsOfExperienceDistribution(applications)).toEqual([{ years: 5, count: 1 }]);
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

describe('coverageForKeywords', () => {
  it('reports a term the skills list carries as skills', () => {
    const coverage = coverageForKeywords([frequencyRow({ term: 'TypeScript' })], fixtureProfile);

    expect(coverage.get('TypeScript')).toBe('skills');
  });

  it('reports a term only a bullet carries as experience', () => {
    const coverage = coverageForKeywords([frequencyRow({ term: 'migration' })], fixtureProfile);

    expect(coverage.get('migration')).toBe('experience');
  });

  it('reports a term found nowhere as missing', () => {
    const coverage = coverageForKeywords([frequencyRow({ term: 'Rust' })], fixtureProfile);

    expect(coverage.get('Rust')).toBe('missing');
  });

  it('returns an empty map for no keywords', () => {
    expect(coverageForKeywords([], fixtureProfile)).toEqual(new Map());
  });
});

describe('outcomeOf', () => {
  it('reads a human stage as a response, however it ended', () => {
    expect(outcomeOf('phone_screen')).toBe('responded');
    expect(outcomeOf('onsite')).toBe('responded');
    expect(outcomeOf('offer')).toBe('responded');
  });

  it('reads only rejected_ats as no response — the rejection that never reached a person', () => {
    expect(outcomeOf('rejected_ats')).toBe('no-response');
    expect(outcomeOf('rejected')).toBe('responded');
  });

  it('reads applied as pending, never as a rejection', () => {
    expect(outcomeOf('applied')).toBe('pending');
  });
});

describe('responseRate', () => {
  it('excludes pending applications from the denominator rather than counting them against it', () => {
    const applications = [
      application({ stage: 'phone_screen' }),
      application({ stage: 'offer' }),
      application({ stage: 'rejected_ats' }),
      application({ stage: 'rejected_ats' }),
      application({ stage: 'rejected_ats' }),
      application({ stage: 'applied' }),
      application({ stage: 'applied' }),
    ];

    expect(responseRate(applications)).toEqual({
      responded: 2,
      decided: 5,
      pending: 2,
      rate: 2 / 5,
    });
  });

  it('withholds a rate below the minimum sample, reporting the counts alone', () => {
    const applications = [
      application({ stage: 'offer' }),
      application({ stage: 'rejected_ats' }),
      application({ stage: 'rejected_ats' }),
    ];

    expect(responseRate(applications)).toEqual({
      responded: 1,
      decided: 3,
      pending: 0,
      rate: null,
    });
  });

  it('reports a null rate, not zero, when nothing has resolved yet', () => {
    const rate = responseRate([application({ stage: 'applied' })]);

    expect(rate.rate).toBeNull();
    expect(rate.decided).toBe(0);
  });

  it('returns zeros for no applications', () => {
    expect(responseRate([])).toEqual({ responded: 0, decided: 0, pending: 0, rate: null });
  });

  it('reports a rate once exactly the minimum has resolved', () => {
    const applications = Array.from({ length: MIN_DECIDED_FOR_RATE }, () =>
      application({ stage: 'rejected_ats' }),
    );

    expect(responseRate(applications).rate).toBe(0);
  });
});

describe('requirementEvidenceRollup', () => {
  function evidence(
    verdict: RequirementEvidenceEntry['verdict'],
    text = 'Some requirement',
  ): RequirementEvidenceEntry {
    return { requirement: requirement({ text }), verdict, evidence: null };
  }

  it('counts every verdict across the postings that carry evidence', () => {
    const applications = [
      application({
        requirementEvidence: [
          evidence('direct-evidence', 'a'),
          evidence('omitted-profile-evidence', 'b'),
        ],
      }),
      application({ requirementEvidence: [evidence('unsupported', 'c')] }),
    ];

    expect(requirementEvidenceRollup(applications)).toEqual({
      'direct-evidence': 1,
      'skill-only': 0,
      'omitted-profile-evidence': 1,
      'needs-confirmation': 0,
      unsupported: 1,
      total: 3,
      scoredPostings: 2,
      unscoredPostings: 0,
    });
  });

  it('states how many postings carry no evidence rather than folding them into a denominator', () => {
    const rollup = requirementEvidenceRollup([
      application({ requirementEvidence: [evidence('direct-evidence')] }),
      application({ requirementEvidence: null }),
      application({ requirementEvidence: null }),
    ]);

    expect(rollup.scoredPostings).toBe(1);
    expect(rollup.unscoredPostings).toBe(2);
    expect(rollup.total).toBe(1);
  });

  it('counts a scored posting with no requirements as scored, contributing nothing', () => {
    const rollup = requirementEvidenceRollup([application({ requirementEvidence: [] })]);

    expect(rollup.scoredPostings).toBe(1);
    expect(rollup.total).toBe(0);
  });

  it('returns all zeros for no applications', () => {
    expect(requirementEvidenceRollup([])).toEqual({
      'direct-evidence': 0,
      'skill-only': 0,
      'omitted-profile-evidence': 0,
      'needs-confirmation': 0,
      unsupported: 0,
      total: 0,
      scoredPostings: 0,
      unscoredPostings: 0,
    });
  });
});

describe('analyticsReport', () => {
  const today = new Date('2026-03-30T12:00:00.000Z');

  function apps(): Application[] {
    return [
      // In range, applied — TypeScript (evidenced in skills) and Rust (missing), asked by 2 postings.
      application({
        id: 'a',
        createdAt: '2026-03-25T00:00:00.000Z',
        stage: 'applied',
        jobInfo: {
          ...application().jobInfo,
          keywords: [keyword({ term: 'TypeScript' }), keyword({ term: 'Rust' })],
        },
      }),
      // In range, onsite — Rust again (2nd posting) and migration (evidenced in experience).
      application({
        id: 'b',
        createdAt: '2026-03-26T00:00:00.000Z',
        stage: 'onsite',
        jobInfo: {
          ...application().jobInfo,
          keywords: [keyword({ term: 'Rust' }), keyword({ term: 'migration' })],
        },
      }),
      // Out of range entirely (60 days back), must never surface in a 7-day report.
      application({
        id: 'c',
        createdAt: '2026-01-01T00:00:00.000Z',
        stage: 'applied',
        jobInfo: { ...application().jobInfo, keywords: [keyword({ term: 'Go' })] },
      }),
    ];
  }

  it('narrows inRange by range alone, and filtered further by stage', () => {
    const report = analyticsReport(apps(), {
      range: '7d',
      stage: null,
      asOf: today,
      profile: null,
    });

    expect(report.inRange.map((a) => a.id).sort()).toEqual(['a', 'b']);
    expect(report.filtered.map((a) => a.id).sort()).toEqual(['a', 'b']);

    const staged = analyticsReport(apps(), {
      range: '7d',
      stage: 'onsite',
      asOf: today,
      profile: null,
    });
    // Stage narrows `filtered` but never `inRange` — the stage pills count against `inRange`.
    expect(staged.inRange.map((a) => a.id).sort()).toEqual(['a', 'b']);
    expect(staged.filtered.map((a) => a.id)).toEqual(['b']);
  });

  it('computes frequency before any table-only filtering', () => {
    const report = analyticsReport(apps(), {
      range: '7d',
      stage: null,
      asOf: today,
      profile: null,
    });

    // Rust was asked by both in-range postings; TypeScript and migration by one each.
    expect(report.frequency.map((row) => row.term).sort()).toEqual([
      'Rust',
      'TypeScript',
      'migration',
    ]);
  });

  it('computes coverage and gapCount across the whole frequency', () => {
    const withGaps = analyticsReport(apps(), {
      range: '7d',
      stage: null,
      asOf: today,
      profile: fixtureProfile,
    });

    // TypeScript is a skill and migration is evidenced by a bullet — only Rust is a genuine gap.
    expect(withGaps.coverageByTerm?.get('Rust')).toBe('missing');
    expect(withGaps.gapCount).toBe(1);
  });

  it('coverageByTerm and gapCount stay null/0 without a profile, never throwing', () => {
    const report = analyticsReport(apps(), {
      range: '7d',
      stage: null,
      asOf: today,
      profile: null,
    });

    expect(report.coverageByTerm).toBeNull();
    expect(report.gapCount).toBe(0);
  });

  it('suppresses baseline entirely once a stage filter narrows the population', () => {
    const unfiltered = analyticsReport(apps(), {
      range: '7d',
      stage: null,
      asOf: today,
      profile: null,
    });
    expect(unfiltered.baseline).not.toBeNull();

    const staged = analyticsReport(apps(), {
      range: '7d',
      stage: 'onsite',
      asOf: today,
      profile: null,
    });
    expect(staged.baseline).toBeNull();
  });
});

describe('keywordRows', () => {
  const frequency = [
    frequencyRow({ term: 'Rust', count: 2 }),
    frequencyRow({ term: 'TypeScript', count: 1 }),
    frequencyRow({ term: 'migration', count: 1 }),
  ];
  const coverage = new Map<string, 'skills' | 'experience' | 'missing'>([
    ['Rust', 'missing'],
    ['TypeScript', 'skills'],
    ['migration', 'experience'],
  ]);

  it('applies minAppearances without changing frequency itself', () => {
    expect(keywordRows(frequency, null, { minAppearances: 2, gapsOnly: false })).toEqual([
      frequency[0],
    ]);
    expect(frequency).toHaveLength(3);
  });

  it('narrows rows to missing terms when gapsOnly is set', () => {
    expect(keywordRows(frequency, coverage, { minAppearances: 1, gapsOnly: true })).toEqual([
      frequency[0],
    ]);
  });

  it('composes gapsOnly with minAppearances', () => {
    expect(keywordRows(frequency, coverage, { minAppearances: 3, gapsOnly: true })).toEqual([]);
  });

  it('hides every row when gapsOnly has no coverage to score against', () => {
    expect(keywordRows(frequency, null, { minAppearances: 1, gapsOnly: true })).toEqual([]);
  });
});

describe('keywordCoverageSummary', () => {
  it('splits rows into evidenced and gap counts, and rounds the gap percentage', () => {
    const rows = [
      frequencyRow({ term: 'Rust' }),
      frequencyRow({ term: 'TypeScript' }),
      frequencyRow({ term: 'migration' }),
    ];
    const coverage = new Map<string, 'skills' | 'experience' | 'missing'>([
      ['Rust', 'missing'],
      ['TypeScript', 'skills'],
      ['migration', 'experience'],
    ]);

    expect(keywordCoverageSummary(rows, coverage)).toEqual({
      evidenced: 2,
      gaps: 1,
      gapPercent: 33,
    });
  });

  it('reads every row as evidenced without coverage to score against, the same rule keywordRows follows', () => {
    const rows = [frequencyRow({ term: 'Rust' })];

    expect(keywordCoverageSummary(rows, null)).toEqual({ evidenced: 1, gaps: 0, gapPercent: 0 });
  });

  it('reports zero rather than NaN for an empty row set', () => {
    expect(keywordCoverageSummary([], null)).toEqual({ evidenced: 0, gaps: 0, gapPercent: 0 });
  });

  it('describes rows over any slice a caller passes, not a fixed population', () => {
    // The summary strip and the on-screen category groups read different slices of the same
    // table (see the function's own doc comment) — this is what makes that possible.
    const rows = [frequencyRow({ term: 'Rust' }), frequencyRow({ term: 'TypeScript' })];
    const coverage = new Map<string, 'skills' | 'experience' | 'missing'>([['Rust', 'missing']]);

    expect(keywordCoverageSummary(rows, coverage).gaps).toBe(1);
    expect(keywordCoverageSummary(rows.slice(0, 1), coverage).gaps).toBe(1);
    expect(keywordCoverageSummary(rows.slice(1), coverage).gaps).toBe(0);
  });
});

describe('groupByKeywordCategory', () => {
  it('groups rows by category, keeping each group in arrival order', () => {
    const rows = [
      frequencyRow({ term: 'React', category: 'framework' }),
      frequencyRow({ term: 'TypeScript', category: 'language' }),
      frequencyRow({ term: 'Next.js', category: 'framework' }),
    ];

    expect(groupByKeywordCategory(rows)).toEqual([
      { category: 'framework', items: [rows[0], rows[2]] },
      { category: 'language', items: [rows[1]] },
    ]);
  });

  it('groups every uncategorized row under a null category rather than a display label', () => {
    const rows = [frequencyRow({ term: 'react', category: null })];

    expect(groupByKeywordCategory(rows)).toEqual([{ category: null, items: rows }]);
  });

  it('returns nothing for no rows', () => {
    expect(groupByKeywordCategory([])).toEqual([]);
  });

  it('puts categories in first-appearance order, not a fixed sequence', () => {
    const rows = [
      frequencyRow({ term: 'a', category: 'tool' }),
      frequencyRow({ term: 'b', category: 'language' }),
    ];

    expect(groupByKeywordCategory(rows).map((group) => group.category)).toEqual([
      'tool',
      'language',
    ]);
  });
});

describe('requirementsReport', () => {
  function apps(): Application[] {
    return [
      application({
        id: 'older',
        createdAt: '2026-01-01T00:00:00.000Z',
        jobInfo: {
          ...application().jobInfo,
          keywords: [keyword({ term: 'React' })],
          requirements: [requirement({ text: 'React experience', kind: 'required' })],
        },
      }),
      application({
        id: 'newer',
        createdAt: '2026-02-01T00:00:00.000Z',
        jobInfo: {
          ...application().jobInfo,
          keywords: [keyword({ term: 'Vue' })],
          requirements: [requirement({ text: 'Vue experience', kind: 'preferred' })],
        },
      }),
    ];
  }

  it('matches every application when no keyword is selected, newest first', () => {
    const report = requirementsReport(apps(), null);

    expect(report.matching).toHaveLength(2);
    expect(report.sorted.map((a) => a.id)).toEqual(['newer', 'older']);
    expect(report.requirementCounts.total).toBe(2);
  });

  it('narrows matching to postings that asked for the selected keyword', () => {
    const report = requirementsReport(apps(), 'React');

    expect(report.matching.map((a) => a.id)).toEqual(['older']);
    expect(report.sorted.map((a) => a.id)).toEqual(['older']);
    expect(report.requirementCounts).toMatchObject({ required: 1, preferred: 0, total: 1 });
  });

  it('matches case- and spacing-insensitively, via the same normalization the frequency table uses', () => {
    const report = requirementsReport(apps(), 'react');

    expect(report.matching.map((a) => a.id)).toEqual(['older']);
  });

  it('reports no requirements banded when nothing in the matched set carries an importance', () => {
    const report = requirementsReport(apps(), null);

    expect(report.anyBanded).toBe(false);
    expect(report.bandCounts.unbanded).toBe(2);
  });

  it('sums supportedCount and attentionCount from the evidence rollup, exhaustively over every verdict', () => {
    const scored: Application[] = [
      application({
        requirementEvidence: [
          { requirement: requirement({ text: 'a' }), verdict: 'direct-evidence', evidence: null },
          { requirement: requirement({ text: 'b' }), verdict: 'skill-only', evidence: null },
          {
            requirement: requirement({ text: 'c' }),
            verdict: 'omitted-profile-evidence',
            evidence: null,
          },
          {
            requirement: requirement({ text: 'd' }),
            verdict: 'needs-confirmation',
            evidence: null,
          },
          { requirement: requirement({ text: 'e' }), verdict: 'unsupported', evidence: null },
        ],
      }),
    ];

    const report = requirementsReport(scored, null);

    expect(report.supportedCount).toBe(3);
    expect(report.attentionCount).toBe(2);
    // Every verdict lands in exactly one bucket — nothing double-counted, nothing dropped.
    expect(report.supportedCount + report.attentionCount).toBe(report.evidence.total);
  });
});

describe('evidenceByRequirement', () => {
  it('keys one posting’s stored verdicts by the requirement text the list renders', () => {
    const entry: RequirementEvidenceEntry = {
      requirement: requirement({ text: '5+ years of React' }),
      verdict: 'omitted-profile-evidence',
      evidence: 'Led a 400-component design system migration.',
    };

    const byText = evidenceByRequirement(application({ requirementEvidence: [entry] }));

    expect(byText.get('5+ years of React')).toBe(entry);
  });

  it('returns an empty map for a posting saved before evidence was computed', () => {
    expect(evidenceByRequirement(application({ requirementEvidence: null }))).toEqual(new Map());
  });
});
