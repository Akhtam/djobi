import { TailoredResumeSchema, type JobInfo, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  MODEL: 'claude-sonnet-5',
}));

const { tailorResume } = await import('./tailorResume.js');

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [
    {
      company: 'Acme Corp',
      title: 'Senior Software Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: ['Led the billing service migration'],
    },
  ],
  education: [],
  skills: ['TypeScript', 'PostgreSQL'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: ['TypeScript', 'Postgres'],
};

const sampleTailoredResume = {
  skills: ['TypeScript', 'PostgreSQL'],
  workExperience: profile.workExperience,
};

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_tailored_resume', input }],
  };
}

describe('tailorResume', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('calls the writing model with a forced tool call and returns the validated resume', async () => {
    mockCreate.mockResolvedValue(toolUseResponse(sampleTailoredResume));

    const result = await tailorResume(profile, jobInfo);

    expect(result).toEqual(sampleTailoredResume);
    expect(TailoredResumeSchema.safeParse(result).success).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const request = mockCreate.mock.calls[0][0];
    const content = request.messages[0].content;
    expect(request.model).toBe('claude-sonnet-5');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_tailored_resume' });
    expect(content).toContain(
      JSON.stringify({
        workExperience: profile.workExperience,
        skills: profile.skills,
      }),
    );
    expect(content).toContain(JSON.stringify(jobInfo));
    expect(content).not.toContain(profile.fullName);
    expect(content).not.toContain('"education"');
    expect(content).not.toContain('\n  "workExperience"');
  });

  it('throws when the tool input fails schema validation', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ skills: 'not-an-array' }));

    await expect(tailorResume(profile, jobInfo)).rejects.toThrow(
      'report_tailored_resume produced input that failed validation',
    );
  });

  it('rejects bullets from a fabricated entry and filters fabricated skills', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skills: ['Rust', ' typescript '],
        workExperience: [
          {
            company: 'Fabricated Inc',
            title: 'Chief Architect',
            startDate: '1999-01',
            endDate: '2099-12',
            bullets: ['Emphasized the real billing migration for this role'],
          },
        ],
      }),
    );

    const result = await tailorResume(profile, jobInfo);

    expect(result).toEqual({
      skills: ['TypeScript'],
      workExperience: [
        {
          ...profile.workExperience[0],
          bullets: profile.workExperience[0].bullets,
        },
      ],
    });
  });

  it('never attaches invented-employer bullets to the one unmatched profile entry', async () => {
    const twoJobProfile: Profile = {
      ...profile,
      workExperience: [
        ...profile.workExperience,
        {
          company: 'Beta Corp',
          title: 'Software Engineer',
          startDate: '2020-01',
          endDate: '2021-12',
          bullets: ['Built authoritative internal developer tooling'],
        },
      ],
    };
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skills: profile.skills,
        workExperience: [
          {
            ...twoJobProfile.workExperience[0],
            bullets: ['Tailored the real Acme billing migration'],
          },
          {
            company: 'Invented LLC',
            title: 'Founder',
            startDate: '2010-01',
            endDate: null,
            bullets: ['Fabricated an unrelated company achievement'],
          },
        ],
      }),
    );

    const result = await tailorResume(twoJobProfile, jobInfo);

    expect(result.workExperience).toEqual([
      {
        ...twoJobProfile.workExperience[0],
        bullets: ['Tailored the real Acme billing migration'],
      },
      twoJobProfile.workExperience[1],
    ]);
  });

  it('drops invented entries while retaining safely keyed model reordering', async () => {
    const twoJobProfile: Profile = {
      ...profile,
      workExperience: [
        ...profile.workExperience,
        {
          company: 'Beta Corp',
          title: 'Software Engineer',
          startDate: '2020-01',
          endDate: '2021-12',
          bullets: ['Built internal developer tooling'],
        },
      ],
    };
    const reordered = [twoJobProfile.workExperience[1], twoJobProfile.workExperience[0]];
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skills: profile.skills,
        workExperience: [
          ...reordered,
          {
            company: 'Invented LLC',
            title: 'Founder',
            startDate: '2010-01',
            endDate: null,
            bullets: ['Founded an invented company'],
          },
        ],
      }),
    );

    const result = await tailorResume(twoJobProfile, jobInfo);

    expect(result.workExperience).toEqual(reordered);
    expect(result.workExperience).toHaveLength(2);
  });
});
