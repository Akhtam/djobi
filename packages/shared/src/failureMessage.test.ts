import { describe, expect, it } from 'vitest';
import { failureMessage } from './failureMessage.js';

describe('failureMessage', () => {
  it.each([
    [new Error('boom'), 'boom'],
    ['failed', 'failed'],
    [42, '42'],
    [null, 'Unknown error'],
    [undefined, 'Unknown error'],
    ['', 'Unknown error'],
    [new Error(''), 'Unknown error'],
  ])('formats %s as a diagnostic string', (value, expected) => {
    expect(failureMessage(value)).toBe(expected);
  });

  it('falls back when coercing an unknown value throws', () => {
    expect(
      failureMessage({
        toString() {
          throw new Error('cannot stringify');
        },
      }),
    ).toBe('Unknown error');
  });
});
