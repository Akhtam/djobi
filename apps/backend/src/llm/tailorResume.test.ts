import { TailoredResumeSchema, type JobInfo, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  MODELS: { extraction: 'claude-haiku-4-5', writing: 'claude-sonnet-5' },
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
    expect(request.model).toBe('claude-sonnet-5');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_tailored_resume' });
    expect(request.messages[0].content).toContain(profile.fullName);
    expect(request.messages[0].content).toContain(jobInfo.company);
    expect(request.messages[0].content).not.toContain('prior_applications_to_this_company');
  });

  it('includes the prior-applications summary in the prompt when provided', async () => {
    mockCreate.mockResolvedValue(toolUseResponse(sampleTailoredResume));

    await tailorResume(profile, jobInfo, 'Previously emphasized the on-call rotation experience.');

    const request = mockCreate.mock.calls[0][0];
    expect(request.messages[0].content).toContain('prior_applications_to_this_company');
    expect(request.messages[0].content).toContain('on-call rotation experience');
  });

  it('throws when the tool input fails schema validation', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ skills: 'not-an-array' }));

    await expect(tailorResume(profile, jobInfo)).rejects.toThrow(
      'report_tailored_resume produced input that failed validation',
    );
  });
});
