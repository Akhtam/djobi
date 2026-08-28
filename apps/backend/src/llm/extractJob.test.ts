import { JobInfoSchema } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  FAST_MODEL: 'claude-haiku-4-5-20251001',
  MODEL: 'claude-sonnet-5',
}));

const { extractJob } = await import('./extractJob.js');

const sampleJobInfo = {
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
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_job_info', input }],
  };
}

describe('extractJob', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('calls the extraction model with a forced tool call and returns the validated job info', async () => {
    mockCreate.mockResolvedValue(toolUseResponse(sampleJobInfo));

    const result = await extractJob('Senior Software Engineer at Acme — Platform team...');

    expect(result).toEqual(sampleJobInfo);
    expect(JobInfoSchema.safeParse(result).success).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const request = mockCreate.mock.calls[0][0];
    expect(request.model).toBe('claude-haiku-4-5-20251001');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_job_info' });
    expect(request.tools[0].name).toBe('report_job_info');
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe('user');
    expect(request.messages[0].content).toContain('Senior Software Engineer at Acme');
  });

  it('throws when the model does not return a tool call', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'no can do' }] });

    await expect(extractJob('some page text')).rejects.toThrow(
      'report_job_info did not produce a tool call.',
    );
  });

  it('throws when the tool input fails schema validation', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ company: 'Acme' }));

    await expect(extractJob('some page text')).rejects.toThrow(
      'report_job_info produced input that failed validation',
    );
  });
});
