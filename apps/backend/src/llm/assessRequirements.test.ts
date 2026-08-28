import type { AssessRequirementsProfile, JobInfo } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
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
  education: [],
  skills: ['TypeScript', 'PostgreSQL'],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: null,
  requirements: ['Experience running Kubernetes', 'A PhD in distributed systems'],
  keywords: [],
};

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_requirement_fit', input }],
  };
}

describe('assessRequirements', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('resolves a bullet pointer into the bullet text, so what reaches the panel is Profile prose and not the model’s', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'met',
            evidence: { kind: 'bullet', roleIndex: 0, bulletIndex: 0 },
            note: '',
          },
        ],
      }),
    );

    const fit = await assessRequirements(profile, jobInfo);

    expect(fit[0]).toEqual({
      requirement: 'Experience running Kubernetes',
      verdict: 'met',
      evidence: BULLET,
      note: '',
    });
  });

  it('resolves a skill pointer against the profile’s own skills list', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'partial',
            evidence: { kind: 'skill', index: 1 },
            note: 'Adjacent, not direct.',
          },
        ],
      }),
    );

    const [entry] = await assessRequirements(profile, jobInfo);

    expect(entry.evidence).toBe('PostgreSQL');
    expect(entry.verdict).toBe('partial');
  });

  it('downgrades a met verdict whose pointer resolves to nothing — an unverifiable claim that the candidate qualifies is the one error worth refusing', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'met',
            evidence: { kind: 'bullet', roleIndex: 0, bulletIndex: 9 },
            note: '',
          },
        ],
      }),
    );

    const [entry] = await assessRequirements(profile, jobInfo);

    expect(entry).toEqual({
      requirement: 'Experience running Kubernetes',
      verdict: 'unmet',
      evidence: null,
      note: '',
    });
  });

  it('downgrades a met verdict that offers no pointer at all, rather than taking the word for it', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'met',
            evidence: null,
            note: '',
          },
        ],
      }),
    );

    const [entry] = await assessRequirements(profile, jobInfo);

    expect(entry.verdict).toBe('unmet');
  });

  it('keeps an unmet verdict and its note, which is the row that carries the useful information', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          {
            requirement: 'A PhD in distributed systems',
            verdict: 'unmet',
            evidence: null,
            note: 'Your profile lists no doctorate.',
          },
        ],
      }),
    );

    const fit = await assessRequirements(profile, jobInfo);

    expect(fit[1]).toEqual({
      requirement: 'A PhD in distributed systems',
      verdict: 'unmet',
      evidence: null,
      note: 'Your profile lists no doctorate.',
    });
  });

  it('drops a requirement the posting never stated, so the model cannot add one to answer', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          { requirement: 'Willingness to relocate', verdict: 'unmet', evidence: null, note: 'No.' },
          {
            requirement: 'A PhD in distributed systems',
            verdict: 'unmet',
            evidence: null,
            note: '',
          },
        ],
      }),
    );

    const fit = await assessRequirements(profile, jobInfo);

    expect(fit.map((entry) => entry.requirement)).toEqual(jobInfo.requirements);
    expect(fit.map((entry) => entry.requirement)).not.toContain('Willingness to relocate');
  });

  it('reports each requirement once, in the posting’s order, however the model ordered or repeated them', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          {
            requirement: 'A PhD in distributed systems',
            verdict: 'unmet',
            evidence: null,
            note: '',
          },
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'met',
            evidence: { kind: 'bullet', roleIndex: 0, bulletIndex: 0 },
            note: '',
          },
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'unmet',
            evidence: null,
            note: 'duplicate',
          },
        ],
      }),
    );

    const fit = await assessRequirements(profile, jobInfo);

    expect(fit.map((entry) => entry.requirement)).toEqual(jobInfo.requirements);
    expect(fit[0].verdict).toBe('met');
  });

  it('reports a requirement the model said nothing about as unmet, so silence never reads as qualified', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: [
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'met',
            evidence: { kind: 'bullet', roleIndex: 0, bulletIndex: 0 },
            note: '',
          },
        ],
      }),
    );

    const fit = await assessRequirements(profile, jobInfo);

    expect(fit[1]).toEqual({
      requirement: 'A PhD in distributed systems',
      verdict: 'unmet',
      evidence: null,
      note: '',
    });
  });

  it('accepts a fit array that the model double-encoded as JSON, while still validating its entries', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: JSON.stringify([
          {
            requirement: 'Experience running Kubernetes',
            verdict: 'met',
            evidence: { kind: 'bullet', roleIndex: 0, bulletIndex: 0 },
            note: '',
          },
        ]),
      }),
    );

    const [entry] = await assessRequirements(profile, jobInfo);

    expect(entry).toEqual({
      requirement: 'Experience running Kubernetes',
      verdict: 'met',
      evidence: BULLET,
      note: '',
    });
  });

  it.each([
    // The shapes seen in production. A tool `input_schema` is advisory, so `"type": "array"` on
    // `fit` — asserted below — does not stop the model reaching for a container of its own.
    ['a lone entry sent unwrapped', (entry: unknown) => entry],
    ['the array re-wrapped in the tool envelope', (entry: unknown) => ({ fit: [entry] })],
    ['an index-keyed object', (entry: unknown) => ({ '0': entry })],
  ])('recovers a report the model returned as %s', async (_shape, wrap) => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        fit: wrap({
          requirement: 'Experience running Kubernetes',
          verdict: 'met',
          evidence: { kind: 'bullet', roleIndex: 0, bulletIndex: 0 },
          note: '',
        }),
      }),
    );

    const [entry] = await assessRequirements(profile, jobInfo);

    expect(entry).toEqual({
      requirement: 'Experience running Kubernetes',
      verdict: 'met',
      evidence: BULLET,
      note: '',
    });
  });

  it('still fails a container that is not a report, rather than reinterpreting it into one', async () => {
    // The normalization rearranges containers only. An output that means something else has to
    // reach validation intact — a wrapped-up nonsense entry would become a report of one verdict
    // nobody asked for, which is exactly what this module's reconciliation exists to prevent.
    mockCreate.mockResolvedValue(toolUseResponse({ fit: { unexpected: 'shape' } }));

    await expect(assessRequirements(profile, jobInfo)).rejects.toMatchObject({
      kind: 'invalid-input',
      toolName: 'report_requirement_fit',
    });
  });

  it('spends no model call on a posting whose extraction found no requirements', async () => {
    const fit = await assessRequirements(profile, { ...jobInfo, requirements: [] });

    expect(fit).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('grounds the call in the profile and the job, and forces the tool call like every other writing call', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ fit: [] }));

    await assessRequirements(profile, jobInfo);

    const request = mockCreate.mock.calls[0][0];
    expect(request.model).toBe('claude-sonnet-5');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_requirement_fit' });
    expect(request.tools[0].input_schema.properties.fit.type).toBe('array');
    expect(request.messages[0].content).toContain(JSON.stringify(profile));
    expect(request.messages[0].content).toContain(JSON.stringify(jobInfo));
  });
});
