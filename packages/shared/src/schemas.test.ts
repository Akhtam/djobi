import { describe, expect, it } from 'vitest';
import {
  ApplicationSchema,
  ApplicationSnapshotSchema,
  ApplicationStageSchema,
  baseResumeOf,
  EducationSchema,
  EMPTY_PROFILE,
  parseProfile,
  JobInfoSchema,
  NewApplicationSchema,
  NewNoteSchema,
  NoteSchema,
  ProfileSchema,
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
  createdAt: '2026-08-07T00:00:00.000Z',
};

const validNote = {
  id: 'note-1',
  category: 'technical' as const,
  text: 'Asked to design a rate limiter. They pushed on what happens when Redis is down.',
  createdAt: '2026-08-09T14:15:00.000Z',
};

describe('WorkExperienceSchema', () => {
  it('accepts a valid entry', () => {
    expect(WorkExperienceSchema.safeParse(validWorkExperience).success).toBe(true);
  });

  it('rejects a missing bullets field', () => {
    const { bullets: _bullets, ...withoutBullets } = validWorkExperience;
    expect(WorkExperienceSchema.safeParse(withoutBullets).success).toBe(false);
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
    const { screeningAnswers: _screening, customAnswers: _custom, ...stored } = EMPTY_PROFILE;

    const parsed = parseProfile({ ...stored, fullName: 'Jane Doe' });

    expect(parsed).toMatchObject({
      fullName: 'Jane Doe',
      screeningAnswers: {},
      customAnswers: [],
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
    for (const stage of ['applied', 'rejected_ats', 'phone_screen', 'interviewing', 'rejected']) {
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
  it("carries the profile's skills and work history through unchanged", () => {
    const resume = baseResumeOf(validProfile);
    expect(resume.skills).toEqual(validProfile.skills);
    expect(resume.workExperience).toEqual(validProfile.workExperience);
  });

  it('produces a valid TailoredResume', () => {
    expect(TailoredResumeSchema.safeParse(baseResumeOf(validProfile)).success).toBe(true);
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
