import { describe, expect, it } from 'vitest';
import { applicationPath, parseHash } from './useHashRoute';

describe('parseHash', () => {
  it('reads the list route from the root hash', () => {
    expect(parseHash('#/')).toEqual({ name: 'list' });
  });

  it('reads the list route from an empty hash, as a first visit has', () => {
    expect(parseHash('')).toEqual({ name: 'list' });
  });

  it('reads an application id from a detail hash', () => {
    expect(parseHash('#/applications/app-brex')).toEqual({ name: 'detail', id: 'app-brex' });
  });

  it('decodes an id that needed escaping', () => {
    expect(parseHash('#/applications/a%2Fb')).toEqual({ name: 'detail', id: 'a/b' });
  });

  it('falls back to the list rather than a not-found for an unrecognised hash', () => {
    expect(parseHash('#/nonsense/deep')).toEqual({ name: 'list' });
  });

  it('round-trips an id through applicationPath', () => {
    expect(parseHash(applicationPath('a/b'))).toEqual({ name: 'detail', id: 'a/b' });
  });
});
