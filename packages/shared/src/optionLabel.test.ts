import { describe, expect, it } from 'vitest';
import { labelsMatch, matchOptionLabel, normalizeLabel } from './optionLabel.js';

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
