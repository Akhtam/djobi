import { afterEach, describe, expect, it } from 'vitest';
import { publicOrigins } from './publicOrigins.js';

const original = process.env.PUBLIC_ORIGINS;

afterEach(() => {
  if (original === undefined) delete process.env.PUBLIC_ORIGINS;
  else process.env.PUBLIC_ORIGINS = original;
});

describe('publicOrigins', () => {
  it('is empty when the variable is unset', () => {
    delete process.env.PUBLIC_ORIGINS;
    expect(publicOrigins()).toEqual([]);
  });

  it('is empty when the variable is set but blank, rather than holding an empty origin', () => {
    // `.env.example` ships `PUBLIC_ORIGINS=`, so this is the local-dev default, not an edge case.
    // The `''` it used to produce went straight into both origin allowlists.
    process.env.PUBLIC_ORIGINS = '';
    expect(publicOrigins()).toEqual([]);

    process.env.PUBLIC_ORIGINS = ' , ,';
    expect(publicOrigins()).toEqual([]);
  });

  it('splits and trims a comma-separated list', () => {
    process.env.PUBLIC_ORIGINS = 'https://app.djobi.dev, https://djobi.dev';
    expect(publicOrigins()).toEqual(['https://app.djobi.dev', 'https://djobi.dev']);
  });
});
