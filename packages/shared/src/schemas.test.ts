import { describe, expect, it } from 'vitest';
import {
  ApplicationSchema,
  ApplicationStatusSchema,
  EducationSchema,
  JobInfoSchema,
  NewApplicationSchema,
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
  status: 'draft' as const,
  createdAt: '2026-08-07T00:00:00.000Z',
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

  it('rejects a missing sourceStoryIds field', () => {
    const result = QuestionAnswerSchema.safeParse({
      fieldId: 'field-2',
      question: 'Why this company?',
      answer: 'Because of the mission.',
    });
    expect(result.success).toBe(false);
  });
});

describe('ApplicationStatusSchema', () => {
  it('accepts draft and submitted', () => {
    expect(ApplicationStatusSchema.safeParse('draft').success).toBe(true);
    expect(ApplicationStatusSchema.safeParse('submitted').success).toBe(true);
  });

  it('rejects an arbitrary status', () => {
    expect(ApplicationStatusSchema.safeParse('archived').success).toBe(false);
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

  it('rejects an invalid status', () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, status: 'archived' }).success).toBe(
      false,
    );
  });
});

describe('NewApplicationSchema', () => {
  const { id: _id, createdAt: _createdAt, ...validNewApplication } = validApplication;

  it('accepts an application without id/createdAt', () => {
    expect(NewApplicationSchema.safeParse(validNewApplication).success).toBe(true);
  });

  it('defaults status to draft when omitted', () => {
    const { status: _status, ...withoutStatus } = validNewApplication;
    const result = NewApplicationSchema.safeParse(withoutStatus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('draft');
    }
  });

  it('rejects a missing company', () => {
    const { company: _company, ...withoutCompany } = validNewApplication;
    expect(NewApplicationSchema.safeParse(withoutCompany).success).toBe(false);
  });
});
