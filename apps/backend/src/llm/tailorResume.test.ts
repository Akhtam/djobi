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
      suppressIfEmpty: false,
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
  requirements: [
    { text: '5+ years of backend experience', kind: 'unspecified', yearsOfExperience: null },
  ],
  keywords: [
    { term: 'TypeScript', category: null, postingSpelling: null },
    { term: 'Postgres', category: null, postingSpelling: null },
  ],
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

  it('tells the model, per requirement, what the full bullet bank already evidences — required first', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ workExperience: [{ sourceIndex: 0, bullets: [] }] }),
    );
    const evidencedJobInfo: JobInfo = {
      ...jobInfo,
      requirements: [
        { text: 'Comfort with ambiguity', kind: 'preferred', yearsOfExperience: null },
        { text: 'Led the billing service migration', kind: 'required', yearsOfExperience: null },
      ],
    };

    await tailorResume(profile, evidencedJobInfo);

    const summary = JSON.parse(
      promptText().split('<requirement_evidence>\n')[1].split('\n</requirement_evidence>')[0],
    );
    // Required first, even though it was listed second in the posting.
    expect(summary).toEqual([
      {
        requirement: 'Led the billing service migration',
        kind: 'required',
        verdict: 'direct-evidence',
        evidencedBy: 'Led the billing service migration',
      },
      {
        requirement: 'Comfort with ambiguity',
        kind: 'preferred',
        verdict: 'unsupported',
        evidencedBy: null,
      },
    ]);
    expect(promptText()).toContain('Prioritize keeping or selecting the bullets it names');
  });

  it('omits the requirement_evidence block entirely when the posting states no requirements', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ workExperience: [{ sourceIndex: 0, bullets: [] }] }),
    );

    await tailorResume(profile, { ...jobInfo, requirements: [] });

    expect(promptText()).not.toContain('<requirement_evidence>');
  });

  it('reverts a rewrite to the exact source bullet when it invents a metric the source never stated', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: [
          {
            sourceIndex: 0,
            bullets: [{ sourceIndex: 0, text: 'Cut billing migration downtime by 90%' }],
          },
        ],
      }),
    );

    const result = await tailorResume(profile, jobInfo);

    expect(result.workExperience[0].bullets).toEqual([profile.workExperience[0].bullets[0]]);
  });

  it('reverts a rewrite to the exact source bullet when it names a technology the source never mentioned', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: [
          {
            sourceIndex: 0,
            bullets: [{ sourceIndex: 1, text: 'Owned the on-call rotation using PagerDuty' }],
          },
        ],
      }),
    );

    const result = await tailorResume(profile, jobInfo);

    expect(result.workExperience[0].bullets).toEqual([profile.workExperience[0].bullets[1]]);
  });

  it('keeps a starred bullet immune to the truthfulness check, since it is already the candidate’s own sentence', async () => {
    const starredProfile = {
      ...profile,
      workExperience: [{ ...profile.workExperience[0], starredIndices: [0] }],
    };
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ workExperience: [{ sourceIndex: 0, bullets: [{ sourceIndex: 0 }] }] }),
    );

    const result = await tailorResume(starredProfile, jobInfo);

    expect(result.workExperience[0].bullets).toEqual([profile.workExperience[0].bullets[0]]);
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

  it('keeps role order matching the Profile’s own reverse-chronological order, regardless of the order the model returns roles in', async () => {
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
          // The model lists Beta Corp (index 1) first; Profile order must win regardless.
          { sourceIndex: 1, bullets: [{ sourceIndex: 0, text: 'Built developer tooling' }] },
          { sourceIndex: 0, bullets: [{ sourceIndex: 0, text: 'Led the billing migration' }] },
        ],
      }),
    );

    const result = await tailorResume(twoRoleProfile, jobInfo);

    expect(result.workExperience.map((role) => role.company)).toEqual(['Acme Corp', 'Beta Corp']);
    expect(result.workExperience[1].bullets).toEqual(['Built developer tooling']);
    expect(promptText()).toContain('role order always follows base_profile');
  });

  it('omits a role only when tailoring selected zero bullets for it and the candidate opted into suppression', async () => {
    const emptyableRole = {
      company: 'Beta Corp',
      title: 'Software Engineer',
      startDate: '2020-01',
      endDate: '2021-12',
      bullets: ['Built internal developer tooling'],
      maxBullets: null,
      starredIndices: [],
      suppressIfEmpty: true,
    };
    const twoRoleProfile = {
      ...profile,
      workExperience: [...profile.workExperience, emptyableRole],
    };
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: [
          { sourceIndex: 0, bullets: [{ sourceIndex: 0, text: 'Led the billing migration' }] },
          { sourceIndex: 1, bullets: [] },
        ],
      }),
    );

    const result = await tailorResume(twoRoleProfile, jobInfo);

    expect(result.workExperience.map((role) => role.company)).toEqual(['Acme Corp']);
  });

  it('keeps an empty role visible when suppressIfEmpty was never set, the default', async () => {
    const emptyableRole = {
      company: 'Beta Corp',
      title: 'Software Engineer',
      startDate: '2020-01',
      endDate: '2021-12',
      bullets: ['Built internal developer tooling'],
      maxBullets: null,
      starredIndices: [],
    };
    const twoRoleProfile = {
      ...profile,
      workExperience: [...profile.workExperience, emptyableRole],
    };
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
        workExperience: [
          { sourceIndex: 0, bullets: [{ sourceIndex: 0, text: 'Led the billing migration' }] },
          { sourceIndex: 1, bullets: [] },
        ],
      }),
    );

    const result = await tailorResume(twoRoleProfile, jobInfo);

    expect(result.workExperience.map((role) => role.company)).toEqual(['Acme Corp', 'Beta Corp']);
    expect(result.workExperience[1].bullets).toEqual([]);
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
