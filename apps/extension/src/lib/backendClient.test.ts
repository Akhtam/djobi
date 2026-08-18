/**
 * `backendClient.ts` is a route map: which path, which method, which body. Those three facts are
 * its whole interface, and until now nothing asserted any of them — the module's correctness rode
 * entirely on the two "real adapter" cases in `applicationPipeline.test.ts`.
 *
 * The `satisfies` annotations still do the heavy lifting at compile time; what these cover is the
 * half a type can't see, a path or a method typed wrong. `renderResumePdf` and `getProfile` matter
 * most: both are now called from the panel, which used to build them by hand.
 */
import type { JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callBackend, callBackendBinary } from './callBackend';
import { httpBackendClient } from './backendClient';

vi.mock('./callBackend', () => ({ callBackend: vi.fn(), callBackendBinary: vi.fn() }));

const profile: Profile = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

const tailoredResume: TailoredResume = { skills: [], workExperience: [] };

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Engineer',
  seniority: null,
  location: null,
  requirements: [],
  keywords: [],
};

beforeEach(() => {
  vi.mocked(callBackend).mockReset().mockResolvedValue(undefined);
  vi.mocked(callBackendBinary).mockReset().mockResolvedValue(new ArrayBuffer(0));
});

describe('httpBackendClient', () => {
  it('reads the profile bodyless, over GET', async () => {
    await httpBackendClient.getProfile();

    expect(callBackend).toHaveBeenCalledWith('/profile', undefined, 'GET');
  });

  it('saves the profile as the whole body', async () => {
    await httpBackendClient.saveProfile(profile);

    expect(callBackend).toHaveBeenCalledWith('/profile', profile);
  });

  it('renders the resume through the binary transport, not the JSON one', async () => {
    await httpBackendClient.renderResumePdf(profile, tailoredResume);

    expect(callBackendBinary).toHaveBeenCalledWith('/render-resume-pdf', {
      profile,
      tailoredResume,
    });
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('extracts job info from the pasted description', async () => {
    await httpBackendClient.extractJob('a posting');

    expect(callBackend).toHaveBeenCalledWith('/extract-job', { jobDescription: 'a posting' });
  });

  it('encodes the id into the update path', async () => {
    await httpBackendClient.updateApplication('a b/c', {
      company: 'Acme',
      roleTitle: 'Engineer',
      jobUrl: 'https://example.com/job',
      jobInfo,
      tailoredResume,
      answers: [],
    });

    expect(callBackend).toHaveBeenCalledWith('/applications/a%20b%2Fc', expect.anything(), 'PATCH');
  });

  it('encodes the job URL into the duplicate-lookup query', async () => {
    await httpBackendClient.findApplicationsByJobUrl('https://boards.example.com/j?id=1');

    expect(callBackend).toHaveBeenCalledWith(
      '/applications?jobUrl=https%3A%2F%2Fboards.example.com%2Fj%3Fid%3D1',
      undefined,
      'GET',
    );
  });
});
