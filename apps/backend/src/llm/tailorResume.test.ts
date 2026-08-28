import { TailoredResumeSchema, type JobInfo, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  FAST_MODEL: 'claude-haiku-4-5-20251001',
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
      bullets: ['Led the billing service migration', 'Owned the on-call rotation'],
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

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_tailored_resume', input }],
  };
}

describe('tailorResume', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('reconstructs a public resume from compact source indices', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skillIndices: [0, 1],
        workExperience: [
          {
            sourceIndex: 0,
            bullets: [{ sourceIndex: 0, text: 'Led a job-relevant billing service migration' }],
          },
        ],
      }),
    );

    const result = await tailorResume(profile, jobInfo);

    expect(result).toEqual({
      skills: profile.skills,
      workExperience: [
        {
          ...profile.workExperience[0],
          bullets: ['Led a job-relevant billing service migration'],
        },
      ],
    });
    expect(TailoredResumeSchema.safeParse(result).success).toBe(true);

    const request = mockCreate.mock.calls[0][0];
    expect(request.model).toBe('claude-sonnet-5');
    expect(request.output_config).toEqual({ effort: 'medium' });
    expect(request.max_tokens).toBe(1856);
    expect(request.tools[0].input_schema.properties).toHaveProperty('skillIndices');
    expect(JSON.stringify(request.tools[0].input_schema)).not.toContain('minimum');
    expect(JSON.stringify(request.tools[0].input_schema)).not.toContain('minLength');
    const roleProperties = request.tools[0].input_schema.properties.workExperience.items.properties;
    expect(roleProperties).toHaveProperty('sourceIndex');
    expect(roleProperties).not.toHaveProperty('company');
    expect(request.messages[0].content).toContain(
      JSON.stringify({ workExperience: profile.workExperience, skills: profile.skills }),
    );
    expect(request.messages[0].content).not.toContain(profile.fullName);
  });

  it('throws when compact tool input fails schema validation', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ skillIndices: 'not-an-array' }));

    await expect(tailorResume(profile, jobInfo)).rejects.toThrow(
      'report_tailored_resume produced input that failed validation',
    );
  });

  it('drops invalid and duplicate skill indices', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skillIndices: [1, -1, 99, 1, 0],
        workExperience: [{ sourceIndex: 0, bullets: [] }],
      }),
    );

    const result = await tailorResume(profile, jobInfo);

    expect(result.skills).toEqual(['PostgreSQL', 'TypeScript']);
  });

  it('uses complete unique role indices to preserve the model-selected role order', async () => {
    const secondRole = {
      company: 'Beta Corp',
      title: 'Software Engineer',
      startDate: '2020-01',
      endDate: '2021-12',
      bullets: ['Built internal developer tooling'],
    };
    const twoRoleProfile = { ...profile, workExperience: [...profile.workExperience, secondRole] };
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skillIndices: [],
        workExperience: [
          { sourceIndex: 1, bullets: [{ sourceIndex: 0, text: 'Built developer tooling' }] },
          { sourceIndex: 0, bullets: [{ sourceIndex: 0, text: 'Led the billing migration' }] },
        ],
      }),
    );

    const result = await tailorResume(twoRoleProfile, jobInfo);

    expect(result.workExperience.map((role) => role.company)).toEqual(['Beta Corp', 'Acme Corp']);
    expect(result.workExperience[0].bullets).toEqual(['Built developer tooling']);
  });

  it('falls back to profile order and content for missing, duplicate, or invalid role indices', async () => {
    const secondRole = {
      company: 'Beta Corp',
      title: 'Software Engineer',
      startDate: '2020-01',
      endDate: '2021-12',
      bullets: ['Built internal developer tooling'],
    };
    const twoRoleProfile = { ...profile, workExperience: [...profile.workExperience, secondRole] };
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skillIndices: [],
        workExperience: [
          { sourceIndex: 0, bullets: [{ sourceIndex: 0, text: 'Ambiguous first rewrite' }] },
          { sourceIndex: 0, bullets: [{ sourceIndex: 0, text: 'Ambiguous second rewrite' }] },
          { sourceIndex: 99, bullets: [{ sourceIndex: 0, text: 'Invented role' }] },
        ],
      }),
    );

    const result = await tailorResume(twoRoleProfile, jobInfo);

    expect(result.workExperience).toEqual(twoRoleProfile.workExperience);
  });

  it('drops invalid bullet pointers and falls back when none of a supplied role resolves', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        skillIndices: [],
        workExperience: [
          {
            sourceIndex: 0,
            bullets: [
              { sourceIndex: 0, text: 'Duplicate A' },
              { sourceIndex: 0, text: 'Duplicate B' },
              { sourceIndex: 99, text: 'Invalid' },
            ],
          },
        ],
      }),
    );

    const result = await tailorResume(profile, jobInfo);

    expect(result.workExperience[0].bullets).toEqual(profile.workExperience[0].bullets);
  });

  it('returns an empty resume without a model call when the profile has no resume content', async () => {
    const emptyProfile = { ...profile, workExperience: [], skills: [] };

    await expect(tailorResume(emptyProfile, jobInfo)).resolves.toEqual({
      skills: [],
      workExperience: [],
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
