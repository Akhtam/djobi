import { describe, expect, it } from 'vitest';
import { isSameJobUrl, jobKeyForUrl } from './jobContext';

describe('jobKeyForUrl', () => {
  it('treats Ashby overview and application routes as the same job', () => {
    const overview = 'https://jobs.ashbyhq.com/acme/9f8b1c2d';
    const application = 'https://jobs.ashbyhq.com/acme/9f8b1c2d/application';

    expect(jobKeyForUrl(application)).toBe(jobKeyForUrl(overview));
    expect(isSameJobUrl(overview, application)).toBe(true);
  });

  it('treats Lever posting and apply routes as the same job', () => {
    expect(
      isSameJobUrl('https://jobs.lever.co/acme/role-1', 'https://jobs.lever.co/acme/role-1/apply'),
    ).toBe(true);
  });

  it('does not carry context to another posting on the same ATS', () => {
    expect(
      isSameJobUrl(
        'https://jobs.ashbyhq.com/acme/role-1/application',
        'https://jobs.ashbyhq.com/acme/role-2',
      ),
    ).toBe(false);
  });

  it('preserves hash-based SPA routes so different jobs do not share context', () => {
    expect(
      isSameJobUrl('https://careers.example.com/#/jobs/1', 'https://careers.example.com/#/jobs/2'),
    ).toBe(false);
    expect(
      isSameJobUrl(
        'https://careers.example.com/#/jobs/1',
        'https://careers.example.com/#/jobs/1/application',
      ),
    ).toBe(true);
  });

  it('still ignores ordinary document anchors', () => {
    expect(
      isSameJobUrl(
        'https://careers.example.com/jobs/1#requirements',
        'https://careers.example.com/jobs/1#qualifications',
      ),
    ).toBe(true);
  });

  it('ignores tracking parameters without discarding meaningful query parameters', () => {
    expect(
      isSameJobUrl(
        'https://careers.example.com/job?id=42&utm_source=linkedin',
        'https://careers.example.com/job?id=42',
      ),
    ).toBe(true);
    expect(
      isSameJobUrl(
        'https://careers.example.com/job?id=42',
        'https://careers.example.com/job?id=43',
      ),
    ).toBe(false);
  });
});
