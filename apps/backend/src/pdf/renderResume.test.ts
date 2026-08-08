import type { Profile, TailoredResume } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { renderResumePdf } from './renderResume.js';

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '555-0100',
  location: 'Remote',
  links: { linkedin: 'linkedin.com/in/janedoe', portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [
    { school: 'State University', degree: 'B.S. Computer Science', field: null, graduationYear: '2018' },
  ],
  skills: ['TypeScript'],
  stories: [],
};

const sampleTailoredResume: TailoredResume = {
  summary: 'Backend engineer with a focus on TypeScript.',
  skills: ['TypeScript', 'Postgres'],
  workExperience: [
    {
      company: 'Acme',
      title: 'Senior Software Engineer',
      startDate: '2020-01',
      endDate: null,
      bullets: ['Built the payments platform.'],
    },
  ],
};

describe('renderResumePdf', () => {
  it('renders a non-empty PDF from a profile and tailored resume', async () => {
    const buffer = await renderResumePdf(sampleProfile, sampleTailoredResume);

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});
