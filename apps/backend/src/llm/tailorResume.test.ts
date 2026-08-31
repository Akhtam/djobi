import { baseResumeOf, TailoredResumeSchema, type JobInfo, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generation,
  mockDoGenerate,
  modelCall,
  objectGeneration,
  openrouter,
  promptText,
} from './fakeModel.js';
import { routeFor } from './routing.js';
import { pageCount, renderResumePdf } from '../pdf/renderResume.js';

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
      maxBullets: null,
      starredIndices: [],
    },
  ],
  maxBulletsPerRole: 6,
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
    // The failure paths below log deliberately — a retry, a redacted validation failure — and
    // `structuredCall.test.ts` is where those lines are asserted. Silenced here so a green run of
    // this file stays silent, and a line that does appear is one nobody expected.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
          company: 'Acme Corp',
          title: 'Senior Software Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['Led a job-relevant billing service migration'],
        },
      ],
    });
    expect(TailoredResumeSchema.safeParse(result).success).toBe(true);
    expect(openrouter.chat).toHaveBeenLastCalledWith(
      routeFor('tailorResume').model,
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
      JSON.stringify({
        workExperience: profile.workExperience,
        maxBulletsPerRole: 6,
        skills: profile.skills,
      }),
    );
    expect(promptText()).not.toContain(profile.fullName);
    expect(promptText()).toContain('natural language that does not sound robotic');
    expect(promptText().indexOf('<base_profile>')).toBeLessThan(promptText().indexOf('<job_info>'));
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
      maxBullets: null,
      starredIndices: [],
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
      maxBullets: null,
      starredIndices: [],
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

    expect(result.workExperience).toEqual([
      {
        company: 'Acme Corp',
        title: 'Senior Software Engineer',
        startDate: '2022-01',
        endDate: null,
        bullets: profile.workExperience[0].bullets,
      },
      {
        company: 'Beta Corp',
        title: 'Software Engineer',
        startDate: '2020-01',
        endDate: '2021-12',
        bullets: ['Built internal developer tooling'],
      },
    ]);
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

  it('enforces a role cap as a maximum without padding to it', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: [
          {
            sourceIndex: 0,
            bullets: [
              { sourceIndex: 1, text: 'Reworded on-call ownership' },
              { sourceIndex: 0, text: 'Reworded billing migration' },
            ],
          },
        ],
      }),
    );
    const cappedProfile = {
      ...profile,
      workExperience: [{ ...profile.workExperience[0], maxBullets: 1 }],
    };

    const capped = await tailorResume(cappedProfile, jobInfo);
    expect(capped.workExperience[0].bullets).toEqual(['Reworded on-call ownership']);

    mockDoGenerate.mockResolvedValue(
      objectGeneration({ workExperience: [{ sourceIndex: 0, bullets: [] }] }),
    );
    const omitted = await tailorResume(cappedProfile, jobInfo);
    expect(omitted.workExperience[0].bullets).toEqual([]);
  });

  it('keeps every starred bullet verbatim and lets stars exceed the configured cap', async () => {
    const starredProfile = {
      ...profile,
      workExperience: [
        {
          ...profile.workExperience[0],
          bullets: ['Authored first', 'Selectable middle', 'Authored last'],
          maxBullets: 1,
          starredIndices: [0, 2],
        },
      ],
    };
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: [
          {
            sourceIndex: 0,
            bullets: [
              { sourceIndex: 2 },
              { sourceIndex: 1, text: 'Reworded middle' },
              { sourceIndex: 0, text: 'The model must not rewrite this' },
            ],
          },
        ],
      }),
    );

    const result = await tailorResume(starredProfile, jobInfo);

    expect(result.workExperience[0].bullets).toEqual(['Authored last', 'Authored first']);
    const bulletSchema =
      modelCall().responseFormat.schema.properties.workExperience.items.properties.bullets.items;
    expect(bulletSchema.required).not.toContain('text');
  });

  it('uses a capped authored-order fallback when a required star is absent', async () => {
    const starredProfile = {
      ...profile,
      workExperience: [
        {
          ...profile.workExperience[0],
          bullets: ['First', 'Second', 'Third', 'Required fourth'],
          maxBullets: 2,
          starredIndices: [3],
        },
      ],
    };
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: [
          { sourceIndex: 0, bullets: [{ sourceIndex: 0, text: 'Only non-star returned' }] },
        ],
      }),
    );

    const result = await tailorResume(starredProfile, jobInfo);

    expect(result.workExperience[0].bullets).toEqual(['First', 'Required fourth']);
  });

  it('sizes output from the effective cap rather than the source bank', async () => {
    const modelResult = objectGeneration({ workExperience: [{ sourceIndex: 0, bullets: [] }] });
    mockDoGenerate.mockResolvedValue(modelResult);
    const shortBank = {
      ...profile,
      workExperience: [{ ...profile.workExperience[0], maxBullets: 2 }],
    };
    const deepBank = {
      ...profile,
      workExperience: [
        {
          ...profile.workExperience[0],
          bullets: Array.from({ length: 15 }, (_, index) => `Bullet ${index + 1}`),
          maxBullets: 2,
        },
      ],
    };

    await tailorResume(shortBank, jobInfo);
    await tailorResume(deepBank, jobInfo);

    expect(modelCall(1).maxOutputTokens).toBe(modelCall(0).maxOutputTokens);
  });

  it('turns a deep bank that spills into a capped resume that fits one page', async () => {
    const deepProfile: Profile = {
      ...profile,
      workExperience: Array.from({ length: 5 }, (_, roleIndex) => ({
        company: `Company ${roleIndex}`,
        title: 'Senior Software Engineer',
        startDate: '2015-01',
        endDate: '2020-01',
        bullets: Array.from(
          { length: 15 },
          (_, bulletIndex) =>
            `Delivered initiative ${bulletIndex} end to end, working across teams to ship it and measuring the result afterwards.`,
        ),
        maxBullets: null,
        starredIndices: [],
      })),
    };
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: deepProfile.workExperience.map((role, sourceIndex) => ({
          sourceIndex,
          bullets: role.bullets.slice(0, 6).map((text, bulletIndex) => ({
            sourceIndex: bulletIndex,
            text,
          })),
        })),
      }),
    );

    const uncapped = await renderResumePdf(deepProfile, baseResumeOf(deepProfile));
    const tailored = await tailorResume(deepProfile, jobInfo);
    const capped = await renderResumePdf(deepProfile, tailored);

    expect(pageCount(uncapped)).toBeGreaterThan(1);
    expect(tailored.workExperience.every((role) => role.bullets.length === 6)).toBe(true);
    expect(pageCount(capped)).toBe(1);
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
