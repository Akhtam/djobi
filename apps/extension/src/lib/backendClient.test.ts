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
      profile: {
        fullName: profile.fullName,
        email: profile.email,
        phone: profile.phone,
        location: profile.location,
        links: profile.links,
        education: profile.education,
      },
      tailoredResume,
    });
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('extracts job info from the pasted description', async () => {
    await httpBackendClient.extractJob('a posting');

    expect(callBackend).toHaveBeenCalledWith('/extract-job', { jobDescription: 'a posting' });
  });

  it('sends only resume fields to tailoring', async () => {
    await httpBackendClient.tailorResume(profile, jobInfo);

    expect(callBackend).toHaveBeenCalledWith('/tailor-resume', {
      profile: { workExperience: profile.workExperience, skills: profile.skills },
      jobInfo,
    });
  });

  it('sends only grounding fields to question drafting', async () => {
    await httpBackendClient.answerQuestions(profile, jobInfo, []);

    expect(callBackend).toHaveBeenCalledWith('/answer-questions', {
      profile: {
        workExperience: profile.workExperience,
        education: profile.education,
        skills: profile.skills,
        stories: profile.stories,
      },
      jobInfo,
      questions: [],
    });
  });

  it('encodes the id into the update path', async () => {
    vi.mocked(callBackend).mockResolvedValue({ id: 'application-1' });
    await httpBackendClient.updateApplication('a b/c', {
      company: 'Acme',
      roleTitle: 'Engineer',
      jobUrl: 'https://example.com/job',
      jobInfo,
      tailoredResume,
      answers: [],
    });

    expect(callBackend).toHaveBeenCalledWith(
      '/applications/a%20b%2Fc?response=compact',
      expect.anything(),
      'PATCH',
    );
  });

  it('encodes the job URL into the duplicate-lookup query', async () => {
    vi.mocked(callBackend).mockResolvedValue({ count: 0, latest: null });
    await expect(
      httpBackendClient.findApplicationDuplicates('https://boards.example.com/j?id=1'),
    ).resolves.toEqual({ count: 0, latest: null });

    expect(callBackend).toHaveBeenCalledWith(
      '/applications?jobUrl=https%3A%2F%2Fboards.example.com%2Fj%3Fid%3D1&response=compact',
      undefined,
      'GET',
    );
  });

  it('parses a duplicate-lookup response with newest application metadata', async () => {
    const summary = {
      count: 2,
      latest: {
        id: 'application-2',
        company: 'Acme',
        roleTitle: 'Engineer',
        createdAt: '2026-08-18T00:00:00.000Z',
      },
    };
    vi.mocked(callBackend).mockResolvedValue(summary);

    await expect(
      httpBackendClient.findApplicationDuplicates('https://boards.example.com/jobs/1'),
    ).resolves.toEqual(summary);
  });

  it.each([
    {
      count: 0,
      latest: { id: 'application-1', company: 'Acme', roleTitle: 'Engineer', createdAt: 'now' },
    },
    { count: 1, latest: null },
  ])('rejects a contradictory duplicate-lookup response: %o', async (summary) => {
    vi.mocked(callBackend).mockResolvedValue(summary);

    await expect(
      httpBackendClient.findApplicationDuplicates('https://boards.example.com/jobs/1'),
    ).rejects.toThrow(/latest must be/);
  });

  it('rejects a malformed optimized response instead of silently losing its id', async () => {
    vi.mocked(callBackend).mockResolvedValue({});

    await expect(
      httpBackendClient.saveApplication({
        company: 'Acme',
        roleTitle: 'Engineer',
        jobUrl: 'https://example.com/job',
        jobInfo,
        tailoredResume,
        answers: [],
      }),
    ).rejects.toThrow();

    expect(callBackend).toHaveBeenCalledWith('/applications?response=compact', expect.anything());
  });
});
