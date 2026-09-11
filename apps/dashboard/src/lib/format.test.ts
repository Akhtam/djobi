import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatShortDate } from './format';

// Noon UTC rather than midnight or a boundary hour: at the timezone offsets a real developer or CI
// runner is actually in (UTC-11 through UTC+13 covers everything but the Line Islands), noon UTC
// still lands on the same calendar day, so these assertions don't depend on where the suite runs.
const NOON_UTC = '2026-03-14T12:00:00Z';

describe('formatDate', () => {
  it('renders a short month, day and year', () => {
    expect(formatDate(NOON_UTC)).toBe('Mar 14, 2026');
  });

  it('pads no leading zero onto a single-digit day', () => {
    expect(formatDate('2026-03-05T12:00:00Z')).toBe('Mar 5, 2026');
  });
});

describe('formatDateTime', () => {
  it('includes the same date words as formatDate, plus a 12-hour time with a zero-padded minute', () => {
    // No literal time string: the hour half is genuinely timezone-dependent, unlike the date half
    // (see `NOON_UTC`'s own reasoning), so this checks shape and zero-padding rather than a value.
    const result = formatDateTime(NOON_UTC);
    expect(result.startsWith(formatDate(NOON_UTC))).toBe(true);
    expect(result).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)$/i);
  });

  it('renders two different minutes of the same hour as two different times', () => {
    // Pins the `minute: '2-digit'` option: without it, `9:05` and `9:09` would both round to `9`.
    const early = formatDateTime('2026-03-14T18:05:00Z');
    const late = formatDateTime('2026-03-14T18:59:00Z');
    expect(early).not.toBe(late);
  });
});

describe('formatShortDate', () => {
  it('renders a short month and day, with no year', () => {
    expect(formatShortDate(new Date(NOON_UTC))).toBe('Mar 14');
    expect(formatShortDate(new Date(NOON_UTC))).not.toContain('2026');
  });

  it('pads no leading zero onto a single-digit day', () => {
    expect(formatShortDate(new Date('2026-03-05T12:00:00Z'))).toBe('Mar 5');
  });
});
