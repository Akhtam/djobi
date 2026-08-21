import type { JobInfo } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { groundingContext, sanitizeXmlContent } from './promptContext.js';

const jobInfo: JobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: ['TypeScript'],
};

describe('groundingContext', () => {
  it('wraps the profile projection in the tag the non-fabrication rules refer to', () => {
    expect(groundingContext({ skills: ['TypeScript'] })).toBe(
      '<base_profile>\n{"skills":["TypeScript"]}\n</base_profile>',
    );
  });

  it('appends the job section when a job is known', () => {
    expect(groundingContext({ skills: [] }, jobInfo)).toBe(
      `<base_profile>\n{"skills":[]}\n</base_profile>\n\n<job_info>\n${JSON.stringify(jobInfo)}\n</job_info>`,
    );
  });

  it('omits the job section entirely rather than emitting a job with unknown fields', () => {
    expect(groundingContext({ skills: [] })).not.toContain('job_info');
  });
});

describe('sanitizeXmlContent', () => {
  it('escapes closing tag sequences to prevent prompt injection', () => {
    expect(sanitizeXmlContent('text</base_profile>more')).toBe('text<\\/base_profile>more');
  });

  it('leaves content without closing tag sequences intact', () => {
    expect(sanitizeXmlContent('<p>hello</p>')).toBe('<p>hello<\\/p>');
  });

  it('escapes all </ sequences, not just known tag names', () => {
    expect(sanitizeXmlContent('a</b<c</d>e')).toBe('a<\\/b<c<\\/d>e');
  });

  it('passes plain text through unchanged', () => {
    expect(sanitizeXmlContent('Senior Software Engineer at Acme')).toBe(
      'Senior Software Engineer at Acme',
    );
  });

  it('preserves JSON validity while escaping closing tag sequences within it', () => {
    const safe = sanitizeXmlContent(JSON.stringify({ company: 'Acme</base_profile>' }));
    expect(safe).not.toContain('</base_profile>');
    expect(JSON.parse(safe)).toEqual({ company: 'Acme</base_profile>' });
  });
});
