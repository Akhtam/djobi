import { describe, expect, it } from 'vitest';
import {
  ApplicationSchema,
  ApplicationSnapshotSchema,
  ApplicationStageSchema,
  AwardSchema,
  baseResumeOf,
  CertificationSchema,
  EducationSchema,
  EMPTY_PROFILE,
  EXTRACTION_VERSION,
  ExtractedProfileSchema,
  parseProfile,
  JobInfoSchema,
  NewApplicationSchema,
  NewNoteSchema,
  NoteSchema,
  ProfileSchema,
  ProjectSchema,
  QuestionAnswerSchema,
  StorySchema,
  TailoredResumeSchema,
  WorkExperienceSchema,
} from './schemas.js';

const validStory = {
  id: 'story-migration-deadline',
  title: 'Migrated the billing service under a hard deadline',
  tags: ['leadership', 'incident-response'],
  situation: 'Legacy billing service was due to be sunset by an external vendor.',
  task: 'Lead the migration to the new service without downtime.',
  action: 'Wrote a dual-write shim, backfilled data, cut over gradually.',
  result: 'Migrated with zero downtime, two weeks ahead of the vendor deadline.',
};

const validWorkExperience = {
  company: 'Acme Corp',
  title: 'Senior Software Engineer',
  startDate: '2022-01',
  endDate: null,
  bullets: ['Led the billing service migration', 'Mentored two junior engineers'],
};

const validEducation = {
  school: 'State University',
  degree: 'B.S.',
  field: 'Computer Science',
  graduationYear: '2018',
};

const validProject = {
  name: 'djobi',
  description: 'AI-tailored job application autofill extension',
  bullets: ['Built a resume-tailoring pipeline against a shared Zod schema'],
  link: 'https://github.com/jane/djobi',
  technologies: ['TypeScript', 'Hono'],
};

const validCertification = {
  name: 'AWS Certified Solutions Architect',
  issuer: 'Amazon Web Services',
  date: '2023-06',
};

const validAward = {
  name: 'Hackathon Winner',
  issuer: 'Acme Corp',
  date: '2022-11',
  description: 'Best use of AI among 40 teams',
};

const validProfile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+1-555-0100',
  location: 'Remote',
  links: { linkedin: 'https://linkedin.com/in/janedoe', portfolio: null, github: null },
  workExperience: [validWorkExperience],
  education: [validEducation],
  skills: ['TypeScript', 'PostgreSQL'],
  stories: [validStory],
};

const validJobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: ['TypeScript', 'Postgres'],
};

const validTailoredResume = {
  skills: ['TypeScript', 'PostgreSQL'],
  workExperience: [validWorkExperience],
};

const validQuestionAnswer = {
  fieldId: 'field-2',
  question: 'Why this company?',
  answer: 'Because of the mission.',
  sourceStoryIds: [],
};

const validApplication = {
  id: 'application-1',
  company: 'Acme',
  roleTitle: 'Senior Software Engineer',
  jobUrl: 'https://acme.com/jobs/123',
  jobInfo: validJobInfo,
  tailoredResume: validTailoredResume,
  answers: [validQuestionAnswer],
  source: 'autofill' as const,
  stage: 'applied' as const,
  notes: [],
  rawDescription: null,
  extractionVersion: null,
  requirementEvidence: null,
  bulletProvenance: null,
  createdAt: '2026-08-07T00:00:00.000Z',
};

const validNote = {
  id: 'note-1',
  category: 'technical' as const,
  text: 'Asked to design a rate limiter. They pushed on what happens when Redis is down.',
  createdAt: '2026-08-09T14:15:00.000Z',
};

describe('WorkExperienceSchema', () => {
  it('accepts a legacy entry and fills the bullet-selection defaults', () => {
    expect(WorkExperienceSchema.parse(validWorkExperience)).toEqual({
      ...validWorkExperience,
      maxBullets: null,
      starredIndices: [],
      suppressIfEmpty: false,
    });
  });

  it('rejects a missing bullets field', () => {
    const { bullets: _bullets, ...withoutBullets } = validWorkExperience;
    expect(WorkExperienceSchema.safeParse(withoutBullets).success).toBe(false);
  });

  it('accepts an uncapped bullet bank and valid starred indices', () => {
    const bullets = Array.from({ length: 20 }, (_, index) => `Bullet ${index + 1}`);

    expect(
      WorkExperienceSchema.parse({
        ...validWorkExperience,
        bullets,
        maxBullets: 4,
        starredIndices: [0, 19],
      }),
    ).toMatchObject({ bullets, maxBullets: 4, starredIndices: [0, 19] });
  });

  it.each([
    ['negative', [-1]],
    ['fractional', [0.5]],
    ['out of range', [2]],
    ['duplicated', [0, 0]],
  ])('rejects %s starred indices', (_label, starredIndices) => {
    const result = WorkExperienceSchema.safeParse({ ...validWorkExperience, starredIndices });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([expect.objectContaining({ path: ['starredIndices'] })]);
    }
  });

  it('accepts zero as a cap so a role may include only its starred bullets', () => {
    expect(WorkExperienceSchema.parse({ ...validWorkExperience, maxBullets: 0 }).maxBullets).toBe(
      0,
    );
  });
});

describe('EducationSchema', () => {
  it('accepts a valid entry', () => {
    expect(EducationSchema.safeParse(validEducation).success).toBe(true);
  });

  it('accepts null field/graduationYear', () => {
    expect(
      EducationSchema.safeParse({ ...validEducation, field: null, graduationYear: null }).success,
    ).toBe(true);
  });
});

describe('ProjectSchema', () => {
  it('accepts a valid project', () => {
    expect(ProjectSchema.safeParse(validProject).success).toBe(true);
  });

  it('accepts null link/technologies', () => {
    expect(
      ProjectSchema.safeParse({ ...validProject, link: null, technologies: null }).success,
    ).toBe(true);
  });

  it('rejects a project missing bullets', () => {
    const { bullets: _bullets, ...withoutBullets } = validProject;
    expect(ProjectSchema.safeParse(withoutBullets).success).toBe(false);
  });
});

describe('CertificationSchema', () => {
  it('accepts a valid certification', () => {
    expect(CertificationSchema.safeParse(validCertification).success).toBe(true);
  });

  it('rejects a certification missing issuer', () => {
    const { issuer: _issuer, ...withoutIssuer } = validCertification;
    expect(CertificationSchema.safeParse(withoutIssuer).success).toBe(false);
  });
});

describe('AwardSchema', () => {
  it('accepts a valid award with a description', () => {
    expect(AwardSchema.safeParse(validAward).success).toBe(true);
  });

  it('accepts an award with no description', () => {
    const { description: _description, ...withoutDescription } = validAward;
    expect(AwardSchema.safeParse(withoutDescription).success).toBe(true);
  });

  it('rejects an award missing date', () => {
    const { date: _date, ...withoutDate } = validAward;
    expect(AwardSchema.safeParse(withoutDate).success).toBe(false);
  });
});

describe('StorySchema', () => {
  it('accepts a valid STAR story', () => {
    expect(StorySchema.safeParse(validStory).success).toBe(true);
  });

  it('rejects a story missing the result field', () => {
    const { result: _result, ...withoutResult } = validStory;
    expect(StorySchema.safeParse(withoutResult).success).toBe(false);
  });

  it('rejects a non-array tags field', () => {
    expect(StorySchema.safeParse({ ...validStory, tags: 'leadership' }).success).toBe(false);
  });
});

describe('ProfileSchema', () => {
  it('accepts a fully populated profile', () => {
    const result = ProfileSchema.safeParse(validProfile);
    expect(result.success).toBe(true);
  });

  it('accepts an empty stories array', () => {
    expect(ProfileSchema.safeParse({ ...validProfile, stories: [] }).success).toBe(true);
  });

  it('upgrades a profile stored before prepared answers existed, filling both defaults', () => {
    // `profiles.data` is jsonb, so a row written before these fields were added comes back without
    // them. Parsing on read is what turns that back into a complete Profile — without it the
    // missing keys reach the Analysis Step as `undefined` and abort it.
    const result = ProfileSchema.safeParse(validProfile);

    expect(result.success && result.data.screeningAnswers).toEqual({});
    expect(result.success && result.data.customAnswers).toEqual([]);
    expect(result.success && result.data.maxBulletsPerRole).toBe(6);
    expect(result.success && result.data.resumePageSize).toBe('A4');
    expect(result.success && result.data.showRolePrefix).toBe(true);
    expect(result.success && result.data.workExperience[0]).toMatchObject({
      maxBullets: null,
      starredIndices: [],
    });
  });

  it('upgrades a profile stored before resume-upload fields existed, filling all four defaults', () => {
    const result = ProfileSchema.safeParse(validProfile);

    expect(result.success && result.data.summary).toBeNull();
    expect(result.success && result.data.projects).toEqual([]);
    expect(result.success && result.data.certifications).toEqual([]);
    expect(result.success && result.data.awards).toEqual([]);
  });

  it('accepts a profile with summary/projects/certifications/awards populated', () => {
    const result = ProfileSchema.safeParse({
      ...validProfile,
      summary: 'Backend engineer focused on reliability.',
      projects: [validProject],
      certifications: [validCertification],
      awards: [validAward],
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.projects).toEqual([validProject]);
    expect(result.success && result.data.certifications).toEqual([validCertification]);
    expect(result.success && result.data.awards).toEqual([validAward]);
  });

  it('rejects a profile missing fullName', () => {
    const { fullName: _fullName, ...withoutName } = validProfile;
    expect(ProfileSchema.safeParse(withoutName).success).toBe(false);
  });

  it('rejects a profile with an invalid story embedded', () => {
    const invalidStory = { ...validStory, tags: undefined };
    const result = ProfileSchema.safeParse({ ...validProfile, stories: [invalidStory] });
    expect(result.success).toBe(false);
  });
});

/**
 * The bootstrap every extension surface runs through. A Profile is read back from jsonb exactly as
 * it was written, so one saved before a field existed comes back without it — and the options form
 * binds straight to those keys, so a missing one used to crash the page on render.
 */
describe('parseProfile', () => {
  it('completes a Profile saved before a field existed, rather than rejecting it', () => {
    const {
      screeningAnswers: _screening,
      customAnswers: _custom,
      maxBulletsPerRole: _maxBullets,
      resumePageSize: _pageSize,
      showRolePrefix: _rolePrefix,
      summary: _summary,
      projects: _projects,
      certifications: _certifications,
      awards: _awards,
      ...stored
    } = EMPTY_PROFILE;

    const parsed = parseProfile({ ...stored, fullName: 'Jane Doe' });

    expect(parsed).toMatchObject({
      fullName: 'Jane Doe',
      screeningAnswers: {},
      customAnswers: [],
      maxBulletsPerRole: 6,
      resumePageSize: 'A4',
      showRolePrefix: true,
      summary: null,
      projects: [],
      certifications: [],
      awards: [],
    });
  });

  /**
   * The nested case a single spread cannot reach, and why this is a function rather than a literal:
   * a stored `links` object missing a key would leave `profile.links.github` undefined, which the
   * options form binds to directly.
   */
  it('completes the nested links a top-level merge would leave half-filled', () => {
    const parsed = parseProfile({ ...EMPTY_PROFILE, links: { linkedin: 'https://li/jane' } });

    expect(parsed.links).toEqual({
      linkedin: 'https://li/jane',
      portfolio: null,
      github: null,
    });
  });

  it.each([
    ['nothing stored yet', undefined],
    ['a null column', null],
    ['a value that is not a Profile at all', { fullName: 42, skills: 'TypeScript' }],
  ])('falls back to an empty Profile for %s', (_label, stored) => {
    // A blank form the candidate can fill in beats a page that won't load.
    expect(parseProfile(stored)).toEqual(EMPTY_PROFILE);
  });
});

describe('JobInfoSchema', () => {
  it('accepts a fully populated job info', () => {
    expect(JobInfoSchema.safeParse(validJobInfo).success).toBe(true);
  });

  it('accepts null team/seniority/location', () => {
    expect(
      JobInfoSchema.safeParse({ ...validJobInfo, team: null, seniority: null, location: null })
        .success,
    ).toBe(true);
  });

  it('rejects a job info missing roleTitle', () => {
    const { roleTitle: _roleTitle, ...withoutRole } = validJobInfo;
    expect(JobInfoSchema.safeParse(withoutRole).success).toBe(false);
  });

  it('lifts a legacy bare-string requirement/keyword to the canonical shape, the way a row stored before this shape existed reads back', () => {
    const parsed = JobInfoSchema.parse(validJobInfo);

    expect(parsed.requirements).toEqual([
      { text: '5+ years of backend experience', kind: 'unspecified', yearsOfExperience: null },
    ]);
    expect(parsed.keywords).toEqual([
      { term: 'TypeScript', category: null, postingSpelling: null },
      { term: 'Postgres', category: null, postingSpelling: null },
    ]);
  });

  it('accepts a requirement/keyword already in the canonical shape and passes it through unchanged', () => {
    const parsed = JobInfoSchema.parse({
      ...validJobInfo,
      requirements: [
        { text: '5+ years of backend experience', kind: 'required', yearsOfExperience: 5 },
      ],
      keywords: [{ term: 'TypeScript', category: 'language', postingSpelling: 'TS' }],
    });

    expect(parsed.requirements).toEqual([
      { text: '5+ years of backend experience', kind: 'required', yearsOfExperience: 5 },
    ]);
    expect(parsed.keywords).toEqual([
      { term: 'TypeScript', category: 'language', postingSpelling: 'TS' },
    ]);
  });

  it('defaults postingSpelling to null for a canonical-shape keyword written before this field existed', () => {
    const parsed = JobInfoSchema.parse({
      ...validJobInfo,
      keywords: [{ term: 'TypeScript', category: 'language' }],
    });

    expect(parsed.keywords).toEqual([
      { term: 'TypeScript', category: 'language', postingSpelling: null },
    ]);
  });

  it('rejects a requirement kind or keyword category outside the closed set, rather than guessing', () => {
    expect(
      JobInfoSchema.safeParse({
        ...validJobInfo,
        requirements: [{ text: 'x', kind: 'nice-to-have', yearsOfExperience: null }],
      }).success,
    ).toBe(false);
    expect(
      JobInfoSchema.safeParse({
        ...validJobInfo,
        keywords: [{ term: 'TypeScript', category: 'backend' }],
      }).success,
    ).toBe(false);
  });

  it('a mix of legacy and canonical rows in one posting parses to canonical shape throughout', () => {
    const parsed = JobInfoSchema.parse({
      ...validJobInfo,
      requirements: [
        '5+ years of backend experience',
        { text: 'Owns incidents', kind: 'preferred', yearsOfExperience: null },
      ],
      keywords: ['TypeScript', { term: 'Postgres', category: 'tool' }],
    });

    expect(parsed.requirements).toEqual([
      { text: '5+ years of backend experience', kind: 'unspecified', yearsOfExperience: null },
      { text: 'Owns incidents', kind: 'preferred', yearsOfExperience: null },
    ]);
    expect(parsed.keywords).toEqual([
      { term: 'TypeScript', category: null, postingSpelling: null },
      { term: 'Postgres', category: 'tool', postingSpelling: null },
    ]);
  });
});

describe('TailoredResumeSchema', () => {
  it('accepts a valid tailored resume', () => {
    expect(TailoredResumeSchema.safeParse(validTailoredResume).success).toBe(true);
  });

  it('rejects a tailored resume missing workExperience', () => {
    const { workExperience: _workExperience, ...withoutExperience } = validTailoredResume;
    expect(TailoredResumeSchema.safeParse(withoutExperience).success).toBe(false);
  });
});

describe('ExtractedProfileSchema', () => {
  const fullExtraction = {
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+1-555-0100',
    location: 'Remote',
    links: { linkedin: 'https://linkedin.com/in/janedoe', portfolio: null, github: null },
    summary: 'Backend engineer focused on reliability.',
    workExperience: [validWorkExperience],
    education: [validEducation],
    skills: ['TypeScript', 'PostgreSQL'],
    projects: [validProject],
    certifications: [validCertification],
    awards: [validAward],
  };

  it('accepts a fully populated extraction', () => {
    expect(ExtractedProfileSchema.safeParse(fullExtraction).success).toBe(true);
  });

  it('accepts an all-blank extraction — a PDF the model could confidently read nothing from', () => {
    const blank = {
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

    expect(ExtractedProfileSchema.safeParse(blank).success).toBe(true);
  });

  it('strips tailoring-selection controls no resume can honestly state, rather than keeping them', () => {
    const result = ExtractedProfileSchema.safeParse({
      ...fullExtraction,
      workExperience: [{ ...validWorkExperience, maxBullets: null, starredIndices: [] }],
    });

    // Extra keys are simply stripped by zod's object parsing, not rejected — this asserts the
    // stripped shape rather than a validation failure, since that's the actual behavior at stake:
    // tailoring controls a resume can't honestly state don't leak into a Profile via extraction.
    expect(result.success && 'maxBullets' in result.data.workExperience[0]).toBe(false);
  });

  it('rejects a missing workExperience array', () => {
    const { workExperience: _workExperience, ...withoutExperience } = fullExtraction;
    expect(ExtractedProfileSchema.safeParse(withoutExperience).success).toBe(false);
  });
});

describe('QuestionAnswerSchema', () => {
  it('accepts a valid question/answer with source stories', () => {
    const result = QuestionAnswerSchema.safeParse({
      fieldId: 'field-2',
      question: 'Tell us about a time you led under pressure.',
      answer: 'During the billing migration...',
      sourceStoryIds: [validStory.id],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty sourceStoryIds array', () => {
    const result = QuestionAnswerSchema.safeParse({
      fieldId: 'field-2',
      question: 'Why this company?',
      answer: 'Because of the mission.',
      sourceStoryIds: [],
    });
    expect(result.success).toBe(true);
  });

  it('reads a missing sourceStoryIds as an empty one, rather than failing the whole batch of answers', () => {
    // The model omits the key instead of sending `[]` when an answer drew on no story. This used
    // to reject, and because `callStructured` validates the tool input as a single object, one
    // omission took every other answer down with it.
    const result = QuestionAnswerSchema.safeParse({
      fieldId: 'field-2',
      question: 'Why this company?',
      answer: 'Because of the mission.',
    });

    expect(result.success).toBe(true);
    expect(result.data?.sourceStoryIds).toEqual([]);
  });
});

describe('ApplicationStageSchema', () => {
  it('accepts every stage in the interview pipeline', () => {
    for (const stage of [
      'applied',
      'rejected_ats',
      'phone_screen',
      'onsite',
      'offer',
      'rejected',
    ]) {
      expect(ApplicationStageSchema.safeParse(stage).success).toBe(true);
    }
  });

  it('rejects an arbitrary stage', () => {
    expect(ApplicationStageSchema.safeParse('ghosted').success).toBe(false);
  });
});

describe('NoteSchema', () => {
  it('accepts a well-formed note', () => {
    expect(NoteSchema.safeParse(validNote).success).toBe(true);
  });

  it('accepts each note category', () => {
    for (const category of ['technical', 'behavioral', 'general']) {
      expect(NoteSchema.safeParse({ ...validNote, category }).success).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(NoteSchema.safeParse({ ...validNote, category: 'salary' }).success).toBe(false);
  });

  it('rejects a missing text', () => {
    const { text: _text, ...withoutText } = validNote;
    expect(NoteSchema.safeParse(withoutText).success).toBe(false);
  });
});

describe('NewNoteSchema', () => {
  it('accepts a note body without id/createdAt', () => {
    expect(
      NewNoteSchema.safeParse({ category: 'general', text: 'Recruiter called.' }).success,
    ).toBe(true);
  });

  it('drops a client-supplied id and createdAt rather than honouring them', () => {
    const result = NewNoteSchema.safeParse(validNote);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ category: validNote.category, text: validNote.text });
    }
  });
});

describe('ApplicationSchema', () => {
  it('accepts a full application row', () => {
    expect(ApplicationSchema.safeParse(validApplication).success).toBe(true);
  });

  it('rejects a missing jobInfo', () => {
    const { jobInfo: _jobInfo, ...withoutJobInfo } = validApplication;
    expect(ApplicationSchema.safeParse(withoutJobInfo).success).toBe(false);
  });

  it('rejects an invalid stage', () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, stage: 'ghosted' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid source', () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, source: 'imported' }).success).toBe(
      false,
    );
  });

  it('requires a source on a stored row', () => {
    const { source: _source, ...withoutSource } = validApplication;
    expect(ApplicationSchema.safeParse(withoutSource).success).toBe(false);
  });
});

describe('ApplicationSnapshotSchema', () => {
  const {
    id: _id,
    createdAt: _createdAt,
    source: _source,
    stage: _stage,
    notes: _notes,
    ...snapshot
  } = validApplication;

  /**
   * The point of the omission: re-saving an autofill must not be able to relabel how the record was
   * created, the same guarantee `stage` and `notes` already have.
   */
  it('rejects a body carrying a source', () => {
    expect(ApplicationSnapshotSchema.safeParse({ ...snapshot, source: 'manual' }).success).toBe(
      false,
    );
  });

  it('accepts a body without one', () => {
    expect(ApplicationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

describe('baseResumeOf', () => {
  /**
   * What manual logging stores in place of a tailored resume, so this has to stay a straight
   * projection — anything reworded here would be a claim the candidate never made.
   */
  it("carries the profile's resume content through without selection metadata", () => {
    const profile = ProfileSchema.parse({
      ...validProfile,
      maxBulletsPerRole: 4,
      workExperience: [{ ...validWorkExperience, maxBullets: 1, starredIndices: [1] }],
    });

    const resume = baseResumeOf(profile);
    expect(resume.skills).toEqual(profile.skills);
    expect(resume.workExperience).toEqual([validWorkExperience]);
    expect(resume.workExperience[0]).not.toHaveProperty('maxBullets');
    expect(resume.workExperience[0]).not.toHaveProperty('starredIndices');
  });

  it('produces a valid TailoredResume', () => {
    expect(
      TailoredResumeSchema.safeParse(baseResumeOf(ProfileSchema.parse(validProfile))).success,
    ).toBe(true);
  });
});

describe('NewApplicationSchema', () => {
  const { id: _id, createdAt: _createdAt, ...validNewApplication } = validApplication;

  it('accepts an application without id/createdAt', () => {
    expect(NewApplicationSchema.safeParse(validNewApplication).success).toBe(true);
  });

  it('defaults stage to applied and notes to empty when omitted', () => {
    // The extension posts a body with neither field; requiring either would 400 every fill.
    const { stage: _stage, notes: _notes, ...withoutTracking } = validNewApplication;
    const result = NewApplicationSchema.safeParse(withoutTracking);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stage).toBe('applied');
      expect(result.data.notes).toEqual([]);
    }
  });

  it("defaults source to 'autofill' when the client omits it", () => {
    // Same reason as stage/notes above: the Fill Step's save path posts no source.
    const { source: _source, ...withoutSource } = validNewApplication;
    expect(NewApplicationSchema.parse(withoutSource).source).toBe('autofill');
  });

  it("keeps an explicit 'manual' source", () => {
    // What the panel's Log tab posts.
    const explicit = { ...validNewApplication, source: 'manual' as const };
    expect(NewApplicationSchema.parse(explicit).source).toBe('manual');
  });

  it('accepts notes supplied explicitly', () => {
    const result = NewApplicationSchema.safeParse({ ...validNewApplication, notes: [validNote] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notes).toEqual([validNote]);
    }
  });

  it('auto-stamps extractionVersion with the current constant when the caller omits it', () => {
    // Nobody has to know this field exists to get an accurate value — same reasoning as
    // stage/notes/source defaulting, so every existing caller keeps working unchanged.
    const { extractionVersion: _extractionVersion, ...withoutVersion } = validNewApplication;
    expect(NewApplicationSchema.parse(withoutVersion).extractionVersion).toBe(EXTRACTION_VERSION);
  });

  it('defaults rawDescription/requirementEvidence/bulletProvenance to null when omitted', () => {
    const {
      rawDescription: _r,
      requirementEvidence: _e,
      bulletProvenance: _b,
      ...rest
    } = validNewApplication;
    const result = NewApplicationSchema.parse(rest);

    expect(result.rawDescription).toBeNull();
    expect(result.requirementEvidence).toBeNull();
    expect(result.bulletProvenance).toBeNull();
  });

  it('accepts an explicit rawDescription, requirementEvidence and bulletProvenance', () => {
    const requirementEvidence = [
      {
        requirement: { text: '5+ years', kind: 'required' as const, yearsOfExperience: 5 },
        verdict: 'direct-evidence' as const,
        evidence: 'Led the billing service migration',
      },
    ];
    const bulletProvenance = [
      {
        company: 'Acme Corp',
        title: 'Senior Software Engineer',
        bullet: 'Led the billing service migration',
        verdict: 'verbatim' as const,
        source: 'Led the billing service migration',
      },
    ];
    const result = NewApplicationSchema.safeParse({
      ...validNewApplication,
      rawDescription: 'Senior Software Engineer at Acme...',
      requirementEvidence,
      bulletProvenance,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rawDescription).toBe('Senior Software Engineer at Acme...');
      expect(result.data.requirementEvidence).toEqual(requirementEvidence);
      expect(result.data.bulletProvenance).toEqual(bulletProvenance);
    }
  });

  it('rejects a missing company', () => {
    const { company: _company, ...withoutCompany } = validNewApplication;
    expect(NewApplicationSchema.safeParse(withoutCompany).success).toBe(false);
  });

  it('rejects an empty job URL', () => {
    expect(NewApplicationSchema.safeParse({ ...validNewApplication, jobUrl: '' }).success).toBe(
      false,
    );
  });
});
