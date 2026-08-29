import { TailoredResumeSchema, type JobInfo, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generation,
  mockDoGenerate,
  modelCall,
  objectGeneration,
  openrouter,
  promptText,
} from './fakeModel.js';

vi.mock('./client.js', () => import('./fakeModel.js'));

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

describe('tailorResume', () => {
  beforeEach(() => {
    mockDoGenerate.mockReset();
  });

  it('reconstructs a public resume from compact source indices', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    expect(openrouter.chat).toHaveBeenLastCalledWith(
      'anthropic/claude-sonnet-5',
      expect.anything(),
    );

    const request = modelCall();
    // Leaving effort unspecified still enabled adaptive reasoning and pushed this small structured
    // call past 20 seconds. Disable it rather than merely declining to request an effort level.
    expect(request.providerOptions?.openrouter).toMatchObject({ reasoning: { effort: 'none' } });
    expect(request.maxOutputTokens).toBe(512);

    const schema = request.responseFormat.schema;
    expect(schema.properties).not.toHaveProperty('skillIndices');
    expect(schema.properties).not.toHaveProperty('skills');
    // Keywords each provider takes a different view of. `strict: true` used to reject these before
    // a request was ever sent; nothing does now, so the schemas have to stay inside the subset
    // every route can serve, and this is what says so.
    expect(JSON.stringify(schema)).not.toContain('minimum');
    expect(JSON.stringify(schema)).not.toContain('minLength');
    const roleProperties = schema.properties.workExperience.items.properties;
    expect(roleProperties).toHaveProperty('sourceIndex');
    expect(roleProperties).not.toHaveProperty('company');
    expect(promptText()).toContain(
      JSON.stringify({ workExperience: profile.workExperience, skills: profile.skills }),
    );
    expect(promptText()).not.toContain(profile.fullName);
  });

  it('throws when the compact output fails schema validation', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration({ workExperience: 'not-an-array' }));

    await expect(tailorResume(profile, jobInfo)).rejects.toThrow(
      'report_tailored_resume produced output that failed validation',
    );
  });

  it('keeps every profile skill unchanged and in profile order', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        // Even a stale or malicious model response cannot choose a subset: this property is outside
        // the output schema, and reconciliation reads skills only from the authoritative Profile.
        skillIndices: [],
        workExperience: [{ sourceIndex: 0, bullets: [] }],
      }),
    );

    const result = await tailorResume(profile, jobInfo);

    expect(result.skills).toEqual(profile.skills);
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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    expect(mockDoGenerate).not.toHaveBeenCalled();
  });

  it('returns every skill without a model call when there is no work experience to tailor', async () => {
    const skillsOnlyProfile = { ...profile, workExperience: [] };

    await expect(tailorResume(skillsOnlyProfile, jobInfo)).resolves.toEqual({
      skills: profile.skills,
      workExperience: [],
    });
    expect(mockDoGenerate).not.toHaveBeenCalled();
  });
});
