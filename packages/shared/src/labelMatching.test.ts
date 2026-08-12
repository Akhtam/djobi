import { describe, expect, it } from 'vitest';
import {
  containsLabel,
  labelsMatch,
  matchByContainment,
  matchOptionLabel,
  normalizeLabel,
  uniqueMatch,
} from './labelMatching.js';

describe('normalizeLabel', () => {
  it('ignores surrounding whitespace and case, the two ways the same label differs between a page and an ATS schema', () => {
    expect(normalizeLabel('  Yes ')).toBe('yes');
    expect(normalizeLabel('YES')).toBe('yes');
  });

  it('keeps everything else, including internal punctuation an option may need to stay distinct', () => {
    expect(normalizeLabel('San Francisco, CA')).toBe('san francisco, ca');
    expect(normalizeLabel('Yes - with a visa')).toBe('yes - with a visa');
  });
});

describe('labelsMatch', () => {
  it('matches labels that differ only in case or surrounding whitespace', () => {
    expect(labelsMatch('Yes', ' yes ')).toBe(true);
  });

  it('does not match labels that differ in substance', () => {
    expect(labelsMatch('Yes', 'Yes, remotely')).toBe(false);
    expect(labelsMatch('No', 'Yes')).toBe(false);
  });
});

describe('matchOptionLabel', () => {
  it("returns the option's own spelling, so a case-only mismatch can be corrected to the text the page actually renders", () => {
    expect(matchOptionLabel(['Yes', 'No'], 'yes')).toBe('Yes');
  });

  it('returns undefined when the answer names no option, rather than force-fitting it to the nearest one', () => {
    expect(matchOptionLabel(['Yes', 'No'], 'Maybe')).toBeUndefined();
  });

  it('returns the first match when options collide once normalized', () => {
    expect(matchOptionLabel(['Remote', 'remote'], 'REMOTE')).toBe('Remote');
  });
});

/**
 * The ambiguity invariant, which every forgiving rule in this module defers to. It used to be
 * re-derived at each call site; these pin it in the one place it now lives.
 */
describe('uniqueMatch', () => {
  it('returns the sole candidate that satisfies the predicate', () => {
    expect(uniqueMatch(['a', 'bb', 'ccc'], (s) => s.length === 2)).toBe('bb');
  });

  it('returns undefined when several candidates match — the input does not say which was meant', () => {
    expect(uniqueMatch(['bb', 'cc'], (s) => s.length === 2)).toBeUndefined();
  });

  it('returns undefined when none match', () => {
    expect(uniqueMatch(['a', 'b'], (s) => s.length === 2)).toBeUndefined();
  });
});

describe('containsLabel', () => {
  it('finds a value inside a container that carries more than the value', () => {
    // A combobox trigger's textContent can hold a placeholder remnant or a clear-button label
    // alongside the selection, so reading it back needs containment, not equality.
    expect(containsLabel('Remote  ✕ Clear', 'remote')).toBe(true);
  });

  it('is false when the value is absent', () => {
    expect(containsLabel('Select an option', 'Remote')).toBe(false);
  });
});

describe('matchByContainment', () => {
  const stored = [
    { question: 'Are you willing to relocate?', answer: 'Yes' },
    { question: 'Do you have a work visa?', answer: 'No' },
  ];
  const questionOf = (entry: { question: string }) => entry.question;

  it("matches a form's longer phrasing against a shorter stored one, despite both ending in '?'", () => {
    // The regression this pins: with trailing punctuation kept, the stored question is not a
    // substring of the form's — the "?" lands mid-phrase — so this exact case, the one the feature
    // exists for, silently never matched.
    expect(
      matchByContainment(stored, questionOf, 'Are you willing to relocate for this role?'),
    ).toBe(stored[0]);
  });

  it('matches in the other direction too — neither side was written with the other in view', () => {
    expect(matchByContainment(stored, questionOf, 'relocate')).toBe(stored[0]);
  });

  it('returns undefined when two stored questions both look like the asked one', () => {
    const ambiguous = [
      { question: 'Are you authorized to work?', answer: 'Yes' },
      { question: 'Are you authorized to work in the US?', answer: 'Yes' },
    ];

    expect(
      matchByContainment(ambiguous, questionOf, 'Are you authorized to work in the US?'),
    ).toBeUndefined();
  });

  it('ignores a stored entry with a blank question rather than matching everything against it', () => {
    expect(matchByContainment([{ question: '   ', answer: 'x' }], questionOf, 'anything')).toBe(
      undefined,
    );
  });

  it('returns undefined for blank input', () => {
    expect(matchByContainment(stored, questionOf, '  ')).toBeUndefined();
  });
});
