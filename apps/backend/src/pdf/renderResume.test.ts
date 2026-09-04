import type { Profile, TailoredResume } from '@djobi/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { DENSITY_STEPS, pageCount, renderResumePdf } from './renderResume.js';
import { preflightResumePdf } from './preflightResume.js';

const sampleProfile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '555-0100',
  location: 'Remote',
  links: { linkedin: 'linkedin.com/in/janedoe', portfolio: null, github: null },
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
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
    const bytes = await renderResumePdf(sampleProfile, sampleTailoredResume);

    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('heads each role with the company, then the title on its own line as "Role: …"', async () => {
    // The layout is the product here, and "it starts with %PDF-" cannot fail on a layout change.
    // Reading the text back is the cheapest check that actually can — the renderer draws each run
    // at its own position top-down, so the extracted order is the rendered order.
    const buffer = await renderResumePdf(sampleProfile, sampleTailoredResume);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });

    expect(text).toContain('Acme 2020-01 – Present');
    expect(text).toContain('Role: Senior Software Engineer');
    // The company leads the line — the old "Senior Software Engineer, Acme" header buried it.
    expect(text).not.toContain('Senior Software Engineer, Acme');
  });

  it('can remove the Role prefix without dropping the title', async () => {
    const buffer = await renderResumePdf(
      { ...sampleProfile, showRolePrefix: false },
      sampleTailoredResume,
    );
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), {
      mergePages: true,
    });

    expect(text).toContain('Senior Software Engineer');
    expect(text).not.toContain('Role: Senior Software Engineer');
  });

  it.each([
    ['A4', 595, 842],
    ['LETTER', 612, 792],
  ] as const)('renders the configured %s page size', async (resumePageSize, width, height) => {
    const buffer = await renderResumePdf(
      { ...sampleProfile, resumePageSize },
      sampleTailoredResume,
    );
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });

    expect(viewport.width).toBeCloseTo(width, 0);
    expect(viewport.height).toBeCloseTo(height, 0);
  });

  it('embeds and extracts Unicode profile and resume text', async () => {
    const profile = { ...sampleProfile, fullName: 'Жанна Доу', location: 'Тбилиси' };
    const tailoredResume = {
      ...sampleTailoredResume,
      skills: ['TypeScript', 'Кириллица'],
      workExperience: [
        {
          ...sampleTailoredResume.workExperience[0],
          company: 'Компания',
          bullets: ['Создала платежную платформу.'],
        },
      ],
    };
    const buffer = await renderResumePdf(profile, tailoredResume);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), {
      mergePages: true,
    });

    expect(text).toContain('Жанна Доу');
    expect(text).toContain('Тбилиси');
    expect(text).toContain('Кириллица');
    expect(text).toContain('Создала платежную платформу.');
  });

  it('preflight rejects a PDF whose expected resume content is missing', async () => {
    const buffer = await renderResumePdf(sampleProfile, sampleTailoredResume);
    const changedResume = {
      ...sampleTailoredResume,
      workExperience: [
        { ...sampleTailoredResume.workExperience[0], bullets: ['Text absent from rendered PDF.'] },
      ],
    };

    await expect(preflightResumePdf(buffer, sampleProfile, changedResume)).rejects.toThrow(
      'missing or out-of-order text',
    );
  });

  it('does not hyphenate a long word that falls at a line wrap', async () => {
    // A renderer that hyphenates splits long words with a real "-" glyph when they land at a line
    // break (e.g. "functionality" -> "function-" / "ality"), which corrupts the rendered text and
    // fails preflight on bullets like this one. `layoutText` keeps an over-long word intact
    // instead; this is the test that holds it to that.
    const tailoredResume: TailoredResume = {
      ...sampleTailoredResume,
      workExperience: [
        {
          ...sampleTailoredResume.workExperience[0],
          bullets: [
            'Collaborated with cross-functional teams to establish a sandbox environment, ensuring seamless functionality across services',
          ],
        },
      ],
    };

    const buffer = await renderResumePdf(sampleProfile, tailoredResume);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), {
      mergePages: true,
    });

    expect(text).toContain('functionality');
  });

  it('keeps tracked headings extractable as whole words', async () => {
    // The name and the section headings are drawn with a non-zero `Tc` (character spacing) to get
    // the design's letter-spacing. `Tc` moves glyph *advance*, so the string in the content stream
    // is untouched and an extractor still reads "SKILLS" — whereas faking the same look by drawing
    // one glyph at a time would extract as "S K I L L S" and break both preflight and every ATS.
    // This is the test that stops that implementation from ever being substituted.
    const bytes = await renderResumePdf(sampleProfile, sampleTailoredResume);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), {
      mergePages: true,
    });

    expect(text).toContain('SKILLS');
    expect(text).toContain('EXPERIENCE');
    expect(text).toContain('EDUCATION');
    expect(text).toContain('Jane Doe');
    expect(text).not.toMatch(/S\s+K\s+I\s+L\s+L\s+S/);
  });

  it('subsets the embedded fonts rather than shipping both full faces', async () => {
    // The two embedded faces are ~0.4 MB together. `save({ subsetFonts: true })` writes only the
    // glyphs a given resume uses; without it every rendered resume carries all 0.4 MB, and the
    // extension attaches that to each application. A plain one-page resume must stay far under the
    // size a single embedded face would already exceed.
    const bytes = await renderResumePdf(sampleProfile, sampleTailoredResume);

    expect(bytes.length).toBeLessThan(200_000);
  });

  it('renders a name written with combining accents (NFD)', async () => {
    // Text does not arrive normalised: `extractPdfText` (pdf.js) routinely yields decomposed
    // sequences from uploaded resumes and the LLM copies the name straight through, so `José` can
    // reach the renderer as `e` + U+0301. The generated subset must carry U+0300–U+036F or the
    // shaper substitutes a different mark, preflight sees text that is not the candidate's own
    // words, and every accented name is a permanent 500 on `POST /render-resume-pdf`.
    const decomposed = { ...sampleProfile, fullName: 'Jose\u0301 Nin\u0303o' };

    const bytes = await renderResumePdf(decomposed, sampleTailoredResume);
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });

    expect(text.normalize('NFC')).toContain('José Niño');
  });

  it('wraps a tracked name that only fits the measure without its tracking', async () => {
    // The name is drawn with `Tc` tracking, which `layoutText` cannot see when it wraps. This name
    // measures 511.2pt against a 511.28pt measure, so untracked it does not wrap — and then draws
    // 528.0pt, 16.7pt past the right margin. Wrapping is the observable proof the measure handed
    // to `layoutText` accounts for the tracking; extraction cannot check the overflow directly,
    // since pdf.js reports glyph advances with `Tc` excluded.
    const longName = 'Wolfeschlegelsteinhausenbergerdorff Maximilian Alexander';

    const bytes = await renderResumePdf(
      { ...sampleProfile, fullName: longName },
      sampleTailoredResume,
    );
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { items } = await (await pdf.getPage(1)).getTextContent();
    const runs = items.flatMap((item) => ('str' in item && item.str ? [item.str] : []));

    expect(runs[0]).toBe('Wolfeschlegelsteinhausenbergerdorff Maximilian');
    expect(runs[1]).toBe('Alexander');
  });

  it('renders a profile that carries no explicit page size', async () => {
    // `resumePageSize` gained a schema default rather than always existing, so a profile built
    // before it — or by hand in a test — simply has none. That is not a reason to fail a render.
    const { resumePageSize: _omitted, ...withoutPageSize } = sampleProfile;

    const bytes = await renderResumePdf(
      withoutPageSize as typeof sampleProfile,
      sampleTailoredResume,
    );

    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('preflight rejects an implausibly small file', async () => {
    await expect(
      preflightResumePdf(new TextEncoder().encode('%PDF-'), sampleProfile, sampleTailoredResume),
    ).rejects.toThrow('file size');
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

  it('allows candidate-forced bullet volume to spill instead of censoring it', async () => {
    // Reconciliation normally caps these roles before rendering. A candidate can deliberately star
    // past that cap, and the renderer must preserve the resulting content even when it needs pages.
    const starredPastCap: TailoredResume = {
      skills: sampleTailoredResume.skills,
      workExperience: Array.from({ length: 5 }, (_, role) => ({
        company: `Company ${role}`,
        title: 'Senior Software Engineer',
        startDate: '2015-01',
        endDate: '2020-01',
        bullets: Array.from(
          { length: 15 },
          (_, bullet) =>
            `Candidate-pinned initiative ${bullet} delivered end to end with cross-team ownership and a measured result.`,
        ),
      })),
    };

    expect(pageCount(await renderResumePdf(sampleProfile, starredPastCap))).toBeGreaterThan(1);
  });
});
