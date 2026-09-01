import { JobInfoSchema } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generation,
  mockDoGenerate,
  modelCall,
  objectGeneration,
  promptText,
} from './fakeModel.js';

vi.mock('./client.js', () => import('./fakeModel.js'));

const { extractJob } = await import('./extractJob.js');

const sampleJobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: [
    { text: '5+ years of backend experience', kind: 'unspecified', yearsOfExperience: null },
  ],
  keywords: [
    { term: 'TypeScript', category: null, postingSpelling: 'TS' },
    { term: 'PostgreSQL', category: null, postingSpelling: 'Postgres' },
  ],
};

describe('extractJob', () => {
  beforeEach(() => {
    mockDoGenerate.mockReset();
    // The failure paths below log deliberately — a retry, a redacted validation failure — and
    // `structuredCall.test.ts` is where those lines are asserted. Silenced here so a green run of
    // this file stays silent, and a line that does appear is one nobody expected.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('calls the extraction model for the job-info object and returns it validated', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(sampleJobInfo));

    const result = await extractJob('Senior Software Engineer at Acme — Platform team...');

    expect(result).toEqual(sampleJobInfo);
    expect(JobInfoSchema.safeParse(result).success).toBe(true);
    expect(mockDoGenerate).toHaveBeenCalledTimes(1);

    // The highest-volume call in the app, and the serial gate the rest of the Analysis Step waits
    // behind — which is why it is routed to the cheapest model that can follow a schema.
    expect(modelCall().responseFormat).toMatchObject({ type: 'json', name: 'report_job_info' });
    expect(modelCall().maxOutputTokens).toBe(2048);
    expect(modelCall().prompt).toHaveLength(1);
    expect(modelCall().prompt[0].role).toBe('user');
    expect(promptText()).toContain('Senior Software Engineer at Acme');
  });

  it('instructs canonical keyword naming and non-fabrication of requirement kind/years', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(sampleJobInfo));

    await extractJob('some page text');

    expect(promptText()).toContain('canonical, expanded, industry-standard form');
    expect(promptText()).toContain('Kubernetes');
    expect(promptText()).toContain('postingSpelling');
    expect(promptText()).toContain('never default to "required"');
    expect(promptText()).toContain('leave it null rather than guessing');
  });

  it('throws when the model answers with something that is not the object', async () => {
    mockDoGenerate.mockResolvedValue(generation('no can do'));

    await expect(extractJob('some page text')).rejects.toThrow(
      'report_job_info did not produce a structured object.',
    );
  });

  it('throws when the generated object fails schema validation', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration({ company: 'Acme' }));

    await expect(extractJob('some page text')).rejects.toThrow(
      'report_job_info produced output that failed validation',
    );
  });
});
