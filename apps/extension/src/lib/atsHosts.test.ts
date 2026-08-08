import { describe, expect, it } from 'vitest';
import { isSupportedAtsHost } from './atsHosts';

describe('isSupportedAtsHost', () => {
  it('matches a supported ATS domain and its subdomains', () => {
    expect(isSupportedAtsHost('greenhouse.io')).toBe(true);
    expect(isSupportedAtsHost('boards.greenhouse.io')).toBe(true);
    expect(isSupportedAtsHost('jobs.lever.co')).toBe(true);
  });

  it('does not match an unrelated host', () => {
    expect(isSupportedAtsHost('example.com')).toBe(false);
  });

  it('does not match a host that merely contains a supported domain as a substring', () => {
    expect(isSupportedAtsHost('notgreenhouse.io')).toBe(false);
    expect(isSupportedAtsHost('greenhouse.io.evil.com')).toBe(false);
  });
});
