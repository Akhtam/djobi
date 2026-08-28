import type { AssessRequirementsProfile, JobInfo } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  FAST_MODEL: 'claude-haiku-4-5-20251001',
  MODEL: 'claude-sonnet-5',
}));

const { assessRequirements } = await import('./assessRequirements.js');

const BULLET = 'Led the billing service migration onto Kubernetes';
const profile: AssessRequirementsProfile = {
  workExperience: [
    {
      company: 'Acme Corp',
      title: 'Senior Software Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: [BULLET, 'Owned the on-call rotation'],
    },
  ],
  education: [
    {
      school: 'State University',
      degree: 'BS',
      field: 'Computer Science',
      graduationYear: '2021',
    },
  ],
  skills: ['TypeScript', 'PostgreSQL'],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: null,
  requirements: ['Experience running Kubernetes', 'A degree in computer science'],
  keywords: [],
};

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_requirement_fit', input }],
  };
}

const unmet = (note = '') => toolUseResponse({ verdict: 'unmet', evidence: null, note });

describe('assessRequirements', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('assesses each requirement independently and restores authoritative text in posting order', async () => {
    mockCreate
      .mockResolvedValueOnce(
        toolUseResponse({
          verdict: 'met',
          evidence: { kind: 'bullet', roleIndex: 0, bulletIndex: 0 },
          note: '',
        }),
      )
      .mockResolvedValueOnce(unmet('Your profile lists no graduate degree.'));

    const fit = await assessRequirements(profile, jobInfo);

    expect(fit).toEqual([
      {
        requirement: jobInfo.requirements[0],
        verdict: 'met',
        evidence: BULLET,
        note: '',
      },
      {
        requirement: jobInfo.requirements[1],
        verdict: 'unmet',
        evidence: null,
        note: 'Your profile lists no graduate degree.',
      },
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ kind: 'skill', index: 1 }, 'PostgreSQL'],
    [{ kind: 'education', index: 0 }, 'BS in Computer Science, State University, 2021'],
    [{ kind: 'role', roleIndex: 0 }, 'Senior Software Engineer at Acme Corp (2022-01-Present)'],
  ])('resolves the verified %o pointer', async (evidence, expected) => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ verdict: 'partial', evidence, note: 'Partial.' }),
    );

    const [entry] = await assessRequirements(profile, {
      ...jobInfo,
      requirements: [jobInfo.requirements[0]],
    });

    expect(entry).toMatchObject({ verdict: 'partial', evidence: expected });
  });

  it.each([
    null,
    { kind: 'skill', index: -1 },
    { kind: 'skill', index: 99 },
    { kind: 'education', index: 99 },
    { kind: 'role', roleIndex: 99 },
    { kind: 'bullet', roleIndex: 0, bulletIndex: 99 },
  ])('downgrades a positive verdict with unresolved evidence %o', async (evidence) => {
    mockCreate.mockResolvedValue(toolUseResponse({ verdict: 'met', evidence, note: '' }));

    const [entry] = await assessRequirements(profile, {
      ...jobInfo,
      requirements: [jobInfo.requirements[0]],
    });

    expect(entry).toMatchObject({ verdict: 'unmet', evidence: null });
  });

  it('discards evidence on an unmet verdict and defaults an omitted note', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ verdict: 'unmet', evidence: { kind: 'skill', index: 0 } }),
    );

    const [entry] = await assessRequirements(profile, {
      ...jobInfo,
      requirements: [jobInfo.requirements[0]],
    });

    expect(entry).toEqual({
      requirement: jobInfo.requirements[0],
      verdict: 'unmet',
      evidence: null,
      note: '',
    });
  });

  it('assesses duplicate requirement text in separate calls rather than collapsing it by value', async () => {
    mockCreate
      .mockResolvedValueOnce(unmet('First assessment.'))
      .mockResolvedValueOnce(unmet('Second assessment.'));

    const fit = await assessRequirements(profile, {
      ...jobInfo,
      requirements: ['Same requirement', 'Same requirement'],
    });

    expect(fit.map((entry) => entry.note)).toEqual(['First assessment.', 'Second assessment.']);
  });

  it('runs at most four requirement generations concurrently', async () => {
    const resolvers: Array<(value: ReturnType<typeof unmet>) => void> = [];
    mockCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const pending = assessRequirements(profile, {
      ...jobInfo,
      requirements: Array.from({ length: 6 }, (_, index) => `Requirement ${index}`),
    });

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(4));
    for (const resolve of resolvers.splice(0, 4)) resolve(unmet());
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(6));
    for (const resolve of resolvers.splice(0)) resolve(unmet());

    await expect(pending).resolves.toHaveLength(6);
  });

  it('aborts active siblings and starts no queued calls after one requirement fails', async () => {
    const failure = new Error('provider unavailable');
    let call = 0;
    mockCreate.mockImplementation((_request, options: { signal?: AbortSignal }) => {
      call += 1;
      if (call === 1) return Promise.reject(failure);
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });

    await expect(
      assessRequirements(profile, {
        ...jobInfo,
        requirements: Array.from({ length: 8 }, (_, index) => `Requirement ${index}`),
      }),
    ).rejects.toBe(failure);

    expect(mockCreate.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mockCreate.mock.calls.slice(1).every(([, options]) => options.signal.aborted)).toBe(
      true,
    );
  });

  it('uses compact Haiku calls containing only the current requirement', async () => {
    mockCreate.mockResolvedValue(unmet());

    await assessRequirements(profile, jobInfo);

    const firstRequest = mockCreate.mock.calls[0][0];
    expect(firstRequest.model).toBe('claude-haiku-4-5-20251001');
    expect(firstRequest).not.toHaveProperty('output_config');
    expect(firstRequest.max_tokens).toBe(512);
    expect(firstRequest.tools[0].input_schema.properties).toHaveProperty('verdict');
    expect(JSON.stringify(firstRequest.tools[0].input_schema)).not.toContain('minimum');
    expect(firstRequest.tools[0].input_schema.properties).not.toHaveProperty('fit');
    expect(firstRequest.tools[0].input_schema.properties).not.toHaveProperty('requirement');
    expect(firstRequest.messages[0].content).toContain(JSON.stringify(jobInfo.requirements[0]));
    expect(firstRequest.messages[0].content).not.toContain(JSON.stringify(jobInfo.requirements[1]));
  });

  it('spends no model call on a posting with no requirements', async () => {
    await expect(assessRequirements(profile, { ...jobInfo, requirements: [] })).resolves.toEqual(
      [],
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
