import { describe, expect, it } from 'vitest';
import {
  analyticsPath,
  applicationPath,
  listPath,
  PAGE_SIZE,
  parseHash,
  type ListFilters,
} from './useHashRoute';

/** The list route under no filters — what every hash without a query string parses to. */
const unfiltered = { name: 'list', filters: { query: '', stage: null }, shown: PAGE_SIZE };

describe('parseHash', () => {
  it('reads the list route from the root hash', () => {
    expect(parseHash('#/')).toEqual(unfiltered);
  });

  it('reads the list route from an empty hash, as a first visit has', () => {
    expect(parseHash('')).toEqual(unfiltered);
  });

  it('reads an application id from a detail hash', () => {
    expect(parseHash('#/applications/app-brex')).toEqual({ name: 'detail', id: 'app-brex' });
  });

  it('decodes an id that needed escaping', () => {
    expect(parseHash('#/applications/a%2Fb')).toEqual({ name: 'detail', id: 'a/b' });
  });

  it('falls back to the list rather than a not-found for an unrecognised hash', () => {
    expect(parseHash('#/nonsense/deep')).toEqual(unfiltered);
  });

  it('round-trips an id through applicationPath', () => {
    expect(parseHash(applicationPath('a/b'))).toEqual({ name: 'detail', id: 'a/b' });
  });

  it('reads the list filters from the query string', () => {
    expect(parseHash('#/?q=vercel&stage=phone_screen')).toEqual({
      name: 'list',
      filters: { query: 'vercel', stage: 'phone_screen' },
      shown: PAGE_SIZE,
    });
  });

  it('normalises a stage that shares a pill onto the pill it shares', () => {
    // `rejected_ats` is a real stage but not a filter — the Rejected pill covers both. Landing on
    // that pill is closer to the intent than dropping the filter and showing everything.
    expect(parseHash('#/?stage=rejected_ats')).toEqual({
      name: 'list',
      filters: { query: '', stage: 'rejected' },
      shown: PAGE_SIZE,
    });
  });

  it('ignores a stage no schema recognises rather than filtering by it', () => {
    // The hash is text a user can edit. A stage taken on trust would narrow the list to nothing
    // and light up no pill, which reads as data loss.
    expect(parseHash('#/?stage=banana')).toEqual(unfiltered);
  });

  it('keeps a query that needed escaping', () => {
    expect(parseHash('#/?q=a%26b')).toEqual({
      name: 'list',
      filters: { query: 'a&b', stage: null },
      shown: PAGE_SIZE,
    });
  });
});

describe('parseHash, analytics', () => {
  it('reads the analytics route from its own hash, defaulting range and stage', () => {
    expect(parseHash('#/analytics')).toEqual({ name: 'analytics', range: '7d', stage: null });
  });

  it('reads range and stage from the query string', () => {
    expect(parseHash('#/analytics?range=7d&stage=onsite')).toEqual({
      name: 'analytics',
      range: '7d',
      stage: 'onsite',
    });
  });

  it('falls back to the default range for a value nothing recognises', () => {
    expect(parseHash('#/analytics?range=lots')).toEqual({
      name: 'analytics',
      range: '7d',
      stage: null,
    });
  });

  it('normalises a stage that shares a pill, the same as the list route', () => {
    expect(parseHash('#/analytics?stage=rejected_ats')).toEqual({
      name: 'analytics',
      range: '7d',
      stage: 'rejected',
    });
  });

  it('round-trips range and stage through analyticsPath', () => {
    expect(parseHash(analyticsPath('60d', 'phone_screen'))).toEqual({
      name: 'analytics',
      range: '60d',
      stage: 'phone_screen',
    });
  });
});

describe('analyticsPath', () => {
  it('writes the bare analytics hash at the default range with no stage filter', () => {
    expect(analyticsPath('7d', null)).toBe('#/analytics');
  });

  it('omits the range param at its default even with a stage set', () => {
    expect(analyticsPath('7d', 'applied')).toBe('#/analytics?stage=applied');
  });

  it('writes a non-default range with no stage filter', () => {
    expect(analyticsPath('30d', null)).toBe('#/analytics?range=30d');
  });

  it('writes both when both are set', () => {
    expect(analyticsPath('14d', 'rejected')).toBe('#/analytics?range=14d&stage=rejected');
  });
});

describe('parseHash, revealed rows', () => {
  it.each([
    ['#/?show=60', 60],
    // Below one batch, zero, negative, fractional and non-numeric all mean "the first batch".
    // `show` is a count the UI has to be able to slice with, and none of these are one.
    ['#/?show=5', PAGE_SIZE],
    ['#/?show=0', PAGE_SIZE],
    ['#/?show=-40', PAGE_SIZE],
    ['#/?show=20.5', PAGE_SIZE],
    ['#/?show=lots', PAGE_SIZE],
  ])('reads %s as %i rows', (hash, shown) => {
    expect(parseHash(hash)).toMatchObject({ name: 'list', shown });
  });

  it('does not cap against a count it cannot know', () => {
    // The list caps this against the rows that actually match; parsing a URL cannot.
    expect(parseHash('#/?show=9999')).toMatchObject({ shown: 9999 });
  });
});

describe('listPath', () => {
  it('writes the bare list hash when nothing is filtered', () => {
    // Not `#/?q=&stage=`: the two render the same list, but only one is a URL worth keeping.
    expect(listPath({ query: '', stage: null })).toBe('#/');
  });

  it('round-trips filters through parseHash', () => {
    const filters: ListFilters = { query: 'a&b=c', stage: 'phone_screen' };
    expect(parseHash(listPath(filters))).toEqual({ name: 'list', filters, shown: PAGE_SIZE });
  });

  it('round-trips a revealed row count', () => {
    const filters: ListFilters = { query: '', stage: null };
    expect(parseHash(listPath(filters, PAGE_SIZE * 3))).toEqual({
      name: 'list',
      filters,
      shown: PAGE_SIZE * 3,
    });
  });

  it('omits the first batch from the URL, so an untouched list stays at #/', () => {
    expect(listPath({ query: '', stage: null }, PAGE_SIZE)).toBe('#/');
  });

  it('omits the half that is empty', () => {
    expect(listPath({ query: '', stage: 'onsite' })).toBe('#/?stage=onsite');
    expect(listPath({ query: 'brex', stage: null })).toBe('#/?q=brex');
  });
});
