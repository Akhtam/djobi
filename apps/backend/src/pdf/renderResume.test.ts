import type { Profile, TailoredResume } from '@djobi/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { DENSITY_STEPS, pageCount, renderResumePdf } from './renderResume.js';

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '555-0100',
  location: 'Remote',
  links: { linkedin: 'linkedin.com/in/janedoe', portfolio: null, github: null },
  workExperience: [],
  education: [
    {
      school: 'State University',
      degree: 'B.S. Computer Science',
      field: null,
      graduationYear: '2018',
    },
  ],
  skills: ['TypeScript'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

const sampleTailoredResume: TailoredResume = {
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

  it('heads each role with the company, then the title on its own line as "Role: …"', async () => {
    // The layout is the product here, and "it starts with %PDF-" cannot fail on a layout change.
    // Reading the text back is the cheapest check that actually can — `@react-pdf/renderer` draws
    // each `<Text>` as its own positioned run, so the extracted order is the rendered order.
    const buffer = await renderResumePdf(sampleProfile, sampleTailoredResume);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });

    expect(text).toContain('Acme 2020-01 – Present');
    expect(text).toContain('Role: Senior Software Engineer');
    // The company leads the line — the old "Senior Software Engineer, Acme" header buried it.
    expect(text).not.toContain('Senior Software Engineer, Acme');
  });

  it('compresses a resume that would overflow back onto a single page', async () => {
    // Five roles of six bullets overflows at the researched density — the first assertion below
    // proves that, so this test fails if the ladder is removed rather than passing on a resume
    // that would have fitted anyway. This is the case the ladder exists for: a tailored resume's
    // length isn't knowable before rendering.
    const long: TailoredResume = {
      skills: sampleTailoredResume.skills,
      workExperience: Array.from({ length: 5 }, (_, role) => ({
        company: `Company ${role}`,
        title: 'Senior Software Engineer',
        startDate: '2015-01',
        endDate: '2020-01',
        bullets: Array.from(
          { length: 6 },
          (_, bullet) =>
            `Delivered initiative ${bullet} end to end, working across teams to ship it and measuring the result afterwards.`,
        ),
      })),
    };

    const atLoosest = await renderResumePdf(sampleProfile, long, [DENSITY_STEPS[0]]);
    expect(pageCount(atLoosest)).toBeGreaterThan(1);

    expect(pageCount(await renderResumePdf(sampleProfile, long))).toBe(1);
  });

  it('keeps every bullet rather than truncating when even the tightest density overflows', async () => {
    // Twelve roles cannot fit however tightly it is set. The resume then runs to two pages *with
    // all of its content*, because silently dropping experience the candidate wrote is a worse
    // failure than a resume that runs long — and one the caller can't detect after the fact.
    const unfittable: TailoredResume = {
      skills: sampleTailoredResume.skills,
      workExperience: Array.from({ length: 12 }, (_, role) => ({
        company: `Company ${role}`,
        title: 'Senior Software Engineer',
        startDate: '2010-01',
        endDate: '2020-01',
        bullets: Array.from(
          { length: 6 },
          (_, bullet) =>
            `Delivered initiative ${bullet} end to end, working across teams to ship it and measuring the result afterwards.`,
        ),
      })),
    };

    const buffer = await renderResumePdf(sampleProfile, unfittable);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), {
      mergePages: true,
    });

    expect(pageCount(buffer)).toBeGreaterThan(1);
    expect(text).toContain('Company 0');
    expect(text).toContain('Company 11');
  });
});
