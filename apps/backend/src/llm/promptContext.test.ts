import type { JobInfo } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { groundingContext } from './promptContext.js';

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
