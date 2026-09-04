import { describe, expect, it, vi } from 'vitest';
import { EMPTY_PROFILE, type ExtractedProfile, type Profile } from '@djobi/shared';
import {
  addSkill,
  applyExtractedProfile,
  changeCredentialKind,
  commaList,
  normalizeProfileDraft,
  optionalList,
  optionalText,
  removeSkill,
  spliceProjectBullets,
  spliceWorkBullets,
  withScreeningAnswer,
} from './profileDraft.js';

const blankExtraction: ExtractedProfile = {
  fullName: null,
  email: null,
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: [],
  projects: [],
  certifications: [],
  awards: [],
};

const story = {
  title: '',
  tags: [],
  situation: '',
  task: '',
  action: '',
  result: '',
};

describe('profile draft normalization', () => {
  it('represents cleared optional inputs and screening answers as absent', () => {
    expect(optionalText('  ')).toBeNull();
    expect(optionalText('  London  ')).toBe('  London  ');
    expect(
      withScreeningAnswer(
        { work_authorization: 'Yes', sponsorship_required: 'No' },
        'sponsorship_required',
        ' ',
      ),
    ).toEqual({ work_authorization: 'Yes' });
    expect(withScreeningAnswer({}, 'sponsorship_required', '  Yes  ')).toEqual({
      sponsorship_required: '  Yes  ',
    });
  });

  it('parses a comma-separated list and drops blank entries', () => {
    expect(commaList(' leadership, , incident-response,')).toEqual([
      'leadership',
      'incident-response',
    ]);
  });

  it('reports an entirely blank comma list as null where the schema stores null', () => {
    expect(optionalList('TypeScript, Postgres')).toEqual(['TypeScript', 'Postgres']);
    // Not `[]`: `technologies` is nullable, and a field the candidate cleared has to round-trip as
    // the same thing a project that never had one stores.
    expect(optionalList('  ,  ')).toBeNull();
    expect(optionalList('')).toBeNull();
  });

  it('splices project bullets without any starred-index bookkeeping', () => {
    const project: Profile['projects'][number] = {
      name: 'djobi',
      description: '',
      bullets: ['first', 'second', 'third'],
      link: null,
      technologies: null,
    };

    // The three cases both editors used to write out inline: edit, remove, append.
    expect(spliceProjectBullets(project, 1, 1, 'rewritten').bullets).toEqual([
      'first',
      'rewritten',
      'third',
    ]);
    expect(spliceProjectBullets(project, 0, 1).bullets).toEqual(['second', 'third']);
    expect(spliceProjectBullets(project, project.bullets.length, 0, '').bullets).toEqual([
      'first',
      'second',
      'third',
      '',
    ]);
  });

  it('adds a skill exactly as typed, and refuses only an empty one', () => {
    const profile: Profile = { ...EMPTY_PROFILE, skills: ['TypeScript'] };

    expect(addSkill(profile, 'Go').skills).toEqual(['TypeScript', 'Go']);
    // Neither trimmed nor deduplicated — showing back what was typed beats quietly altering it.
    expect(addSkill(profile, '  Go  ').skills).toEqual(['TypeScript', '  Go  ']);
    expect(addSkill(profile, 'TypeScript').skills).toEqual(['TypeScript', 'TypeScript']);
    expect(addSkill(profile, '')).toBe(profile);
  });

  it('removes every chip equal to the named skill', () => {
    const profile: Profile = { ...EMPTY_PROFILE, skills: ['Go', 'TypeScript', 'Go'] };
    expect(removeSkill(profile, 'Go').skills).toEqual(['TypeScript']);
    expect(removeSkill(profile, 'Rust').skills).toEqual(['Go', 'TypeScript', 'Go']);
  });

  it('drops blank bullets and repairs blank or duplicate story ids', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      workExperience: [
        {
          company: 'Acme',
          title: 'Engineer',
          startDate: '2024',
          endDate: null,
          bullets: ['Led', ' ', 'Built'],
          maxBullets: null,
          starredIndices: [0, 2],
          suppressIfEmpty: false,
        },
      ],
      stories: [
        { ...story, id: 'keep' },
        { ...story, id: '' },
        { ...story, id: 'duplicate' },
        { ...story, id: 'duplicate' },
      ],
    };
    const generatedIds = ['keep', 'new-1', 'new-2', 'new-3'];
    const createStoryId = vi.fn(() => generatedIds.shift()!);

    const normalized = normalizeProfileDraft(profile, createStoryId);

    expect(normalized.workExperience[0].bullets).toEqual(['Led', 'Built']);
    expect(normalized.workExperience[0].starredIndices).toEqual([0, 1]);
    expect(normalized.stories.map(({ id }) => id)).toEqual(['keep', 'new-1', 'new-2', 'new-3']);
    expect(createStoryId).toHaveBeenCalledTimes(4);
    expect(profile.workExperience[0].bullets).toEqual(['Led', ' ', 'Built']);
    expect(profile.workExperience[0].starredIndices).toEqual([0, 2]);
    expect(profile.stories.map(({ id }) => id)).toEqual(['keep', '', 'duplicate', 'duplicate']);
  });

  it('drops blank bullets from projects the same way it does from work experience', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      projects: [
        {
          name: 'djobi',
          description: 'AI-tailored autofill extension',
          bullets: ['Built the pipeline', ' ', 'Shipped the panel'],
          link: null,
          technologies: null,
        },
      ],
    };

    const normalized = normalizeProfileDraft(profile, () => 'unused');

    expect(normalized.projects[0].bullets).toEqual(['Built the pipeline', 'Shipped the panel']);
    expect(profile.projects[0].bullets).toEqual(['Built the pipeline', ' ', 'Shipped the panel']);
  });

  it('remaps starred indices when bullets are inserted or deleted', () => {
    const entry: Profile['workExperience'][number] = {
      company: 'Acme',
      title: 'Engineer',
      startDate: '2024',
      endDate: null,
      bullets: ['First', 'Second', 'Third'],
      maxBullets: null,
      starredIndices: [0, 2],
      suppressIfEmpty: false,
    };

    const inserted = spliceWorkBullets(entry, 1, 0, 'Inserted');
    expect(inserted.bullets).toEqual(['First', 'Inserted', 'Second', 'Third']);
    expect(inserted.starredIndices).toEqual([0, 3]);

    const removed = spliceWorkBullets(inserted, 0, 2);
    expect(removed.bullets).toEqual(['Second', 'Third']);
    expect(removed.starredIndices).toEqual([1]);
  });
});

describe('applyExtractedProfile', () => {
  it('leaves every field alone when the extraction found nothing', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      fullName: 'Jane Doe',
      phone: '555-0100',
      skills: ['TypeScript'],
    };

    expect(applyExtractedProfile(profile, blankExtraction)).toEqual(profile);
  });

  it('fills every scalar and link field the extraction found', () => {
    const extracted: ExtractedProfile = {
      ...blankExtraction,
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '555-0100',
      location: 'London',
      links: { linkedin: 'linkedin.com/in/ada', portfolio: 'ada.dev', github: null },
      summary: 'Backend engineer.',
    };

    const applied = applyExtractedProfile(EMPTY_PROFILE, extracted);

    expect(applied.fullName).toBe('Ada Lovelace');
    expect(applied.email).toBe('ada@example.com');
    expect(applied.phone).toBe('555-0100');
    expect(applied.location).toBe('London');
    expect(applied.links).toEqual({
      linkedin: 'linkedin.com/in/ada',
      portfolio: 'ada.dev',
      github: null,
    });
    expect(applied.summary).toBe('Backend engineer.');
  });

  it('never blanks a field the candidate already filled in by hand', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      phone: '555-0100',
      links: { linkedin: null, portfolio: 'jane.dev', github: null },
    };

    const applied = applyExtractedProfile(profile, blankExtraction);

    expect(applied.phone).toBe('555-0100');
    expect(applied.links.portfolio).toBe('jane.dev');
  });

  it('replaces workExperience wholesale, defaulting the tailoring controls a resume cannot state', () => {
    const extracted: ExtractedProfile = {
      ...blankExtraction,
      workExperience: [
        {
          company: 'Acme',
          title: 'Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['Shipped things'],
        },
      ],
    };
    const profile: Profile = {
      ...EMPTY_PROFILE,
      workExperience: [
        {
          company: 'Old Co',
          title: 'Old Role',
          startDate: '2018-01',
          endDate: '2021-12',
          bullets: ['Old bullet'],
          maxBullets: 3,
          starredIndices: [0],
          suppressIfEmpty: true,
        },
      ],
    };

    const applied = applyExtractedProfile(profile, extracted);

    expect(applied.workExperience).toEqual([
      {
        company: 'Acme',
        title: 'Engineer',
        startDate: '2022-01',
        endDate: null,
        bullets: ['Shipped things'],
        maxBullets: null,
        starredIndices: [],
        suppressIfEmpty: false,
      },
    ]);
  });

  it('keeps the existing workExperience/education/skills/projects/certifications/awards when the extraction found none', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      education: [{ school: 'State U', degree: 'BS', field: 'CS', graduationYear: '2018' }],
      skills: ['TypeScript'],
      projects: [
        { name: 'djobi', description: 'Autofill', bullets: [], link: null, technologies: null },
      ],
      certifications: [{ name: 'AWS', issuer: 'Amazon', date: '2023' }],
      awards: [{ name: 'Hack Day', issuer: 'Acme', date: '2020' }],
    };

    const applied = applyExtractedProfile(profile, blankExtraction);

    expect(applied.education).toEqual(profile.education);
    expect(applied.skills).toEqual(profile.skills);
    expect(applied.projects).toEqual(profile.projects);
    expect(applied.certifications).toEqual(profile.certifications);
    expect(applied.awards).toEqual(profile.awards);
  });

  it('replaces education, skills, projects, certifications and awards wholesale when the extraction found them', () => {
    const extracted: ExtractedProfile = {
      ...blankExtraction,
      education: [{ school: 'MIT', degree: 'MS', field: 'CS', graduationYear: '2020' }],
      skills: ['Rust'],
      projects: [
        {
          name: 'New project',
          description: 'From the resume',
          bullets: [],
          link: null,
          technologies: null,
        },
      ],
      certifications: [{ name: 'GCP', issuer: 'Google', date: '2024' }],
      awards: [{ name: 'Best Intern', issuer: 'Acme', date: '2019' }],
    };
    const profile: Profile = {
      ...EMPTY_PROFILE,
      education: [{ school: 'State U', degree: 'BS', field: 'CS', graduationYear: '2018' }],
      skills: ['TypeScript'],
    };

    const applied = applyExtractedProfile(profile, extracted);

    expect(applied.education).toEqual(extracted.education);
    expect(applied.skills).toEqual(extracted.skills);
    expect(applied.projects).toEqual(extracted.projects);
    expect(applied.certifications).toEqual(extracted.certifications);
    expect(applied.awards).toEqual(extracted.awards);
  });

  it('does not mutate the original profile', () => {
    const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe' };
    const extracted: ExtractedProfile = { ...blankExtraction, fullName: 'Ada Lovelace' };

    applyExtractedProfile(profile, extracted);

    expect(profile.fullName).toBe('Jane Doe');
  });
});

describe('changeCredentialKind', () => {
  it('moves a certification to awards, dropping the fields awards do not have', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      certifications: [{ name: 'AWS SA', issuer: 'Amazon', date: '2023' }],
      awards: [{ name: 'Hack Day', issuer: 'Acme', date: '2020', description: 'Won first place' }],
    };

    const next = changeCredentialKind(profile, 0, 'certification', 'award', {
      name: 'AWS SA',
      issuer: 'Amazon',
      date: '2023',
    });

    expect(next.certifications).toEqual([]);
    expect(next.awards).toEqual([
      { name: 'Hack Day', issuer: 'Acme', date: '2020', description: 'Won first place' },
      { name: 'AWS SA', issuer: 'Amazon', date: '2023' },
    ]);
  });

  it('moves an award to certifications, dropping its description', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      awards: [{ name: 'Hack Day', issuer: 'Acme', date: '2020', description: 'Won first place' }],
    };

    const next = changeCredentialKind(profile, 0, 'award', 'certification', {
      name: 'Hack Day',
      issuer: 'Acme',
      date: '2020',
    });

    expect(next.awards).toEqual([]);
    expect(next.certifications).toEqual([{ name: 'Hack Day', issuer: 'Acme', date: '2020' }]);
  });

  it('is a no-op when the row is already the target kind', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      certifications: [{ name: 'AWS SA', issuer: 'Amazon', date: '2023' }],
    };

    const next = changeCredentialKind(profile, 0, 'certification', 'certification', {
      name: 'AWS SA',
      issuer: 'Amazon',
      date: '2023',
    });

    expect(next).toBe(profile);
  });
});
