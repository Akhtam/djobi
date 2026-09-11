/**
 * `backendClient.ts` is a route map: which path, which method, which body. Those three facts are
 * its whole interface, and until now nothing asserted any of them — the module's correctness rode
 * entirely on the two "real adapter" cases in `applicationPipeline.test.ts`.
 *
 * The `satisfies` annotations still do the heavy lifting at compile time; what these cover is the
 * half a type can't see, a path or a method typed wrong. `renderResumePdf` and `getProfile` matter
 * most: both are now called from the panel, which used to build them by hand.
 *
 * Each route also names the schema its response is decoded through, which the projection cases below
 * pass over with `expect.anything()` — what matters there is the request. The cases that do care
 * feed a response through {@link respondWith}, which applies the route's own schema exactly as the
 * real transport does, so attaching the wrong one to a route fails here rather than in production.
 */
import type { JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callBackend, callBackendBinary, callBackendUpload } from './callBackend';
import { httpBackendClient } from './backendClient';

vi.mock('./callBackend', () => ({
  callBackend: vi.fn(),
  callBackendBinary: vi.fn(),
  callBackendUpload: vi.fn(),
}));

const profile: Profile = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
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

/**
 * Answers the next call the way the backend would, decoded through whichever schema the client
 * handed the transport. Mocking `callBackend` to resolve a raw value instead would skip the
 * response contract, which is half of what each route declares.
 */
function respondWith(body: unknown) {
  vi.mocked(callBackend).mockImplementation(async (_path, schema) => schema.parse(body));
}

beforeEach(() => {
  vi.mocked(callBackend).mockReset().mockResolvedValue(undefined);
  vi.mocked(callBackendBinary).mockReset().mockResolvedValue(new ArrayBuffer(0));
  vi.mocked(callBackendUpload).mockReset().mockResolvedValue(undefined);
});

describe('httpBackendClient', () => {
  it('reads the profile bodyless, over GET', async () => {
    await httpBackendClient.getProfile();

    expect(callBackend).toHaveBeenCalledWith('/profile', expect.anything(), { method: 'GET' });
  });

  it('saves the profile as the whole body', async () => {
    await httpBackendClient.saveProfile(profile);

    expect(callBackend).toHaveBeenCalledWith('/profile', expect.anything(), { body: profile });
  });

  it('uploads the resume through the multipart transport, under the "resume" field', async () => {
    const file = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    const signal = new AbortController().signal;

    await httpBackendClient.extractResume(file, signal);

    expect(callBackendUpload).toHaveBeenCalledWith(
      '/profile/extract-resume',
      expect.anything(),
      expect.any(FormData),
      signal,
    );
    const formData = vi.mocked(callBackendUpload).mock.calls[0][2];
    expect(formData.get('resume')).toBe(file);
  });

  it('renders the resume through the binary transport, not the JSON one', async () => {
    // The signal goes with it: this is the Fill Step's model work, and forwarding it here is what
    // makes the one route that used to be uncancellable cancellable.
    const signal = new AbortController().signal;
    await httpBackendClient.renderResumePdf(profile, tailoredResume, signal);

    expect(callBackendBinary).toHaveBeenCalledWith(
      '/render-resume-pdf',
      {
        profile: {
          fullName: profile.fullName,
          email: profile.email,
          phone: profile.phone,
          location: profile.location,
          links: profile.links,
          education: profile.education,
          resumePageSize: profile.resumePageSize,
          showRolePrefix: profile.showRolePrefix,
        },
        tailoredResume,
      },
      signal,
    );
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('extracts job info from the pasted description', async () => {
    await httpBackendClient.extractJob('a posting');

    expect(callBackend).toHaveBeenCalledWith('/extract-job', expect.anything(), {
      body: { jobDescription: 'a posting' },
      signal: undefined,
    });
  });

  it('sends only resume fields to tailoring', async () => {
    await httpBackendClient.tailorResume(profile, jobInfo);

    expect(callBackend).toHaveBeenCalledWith('/tailor-resume', expect.anything(), {
      body: {
        profile: {
          workExperience: profile.workExperience,
          maxBulletsPerRole: profile.maxBulletsPerRole,
          skills: profile.skills,
        },
        jobInfo,
      },
      signal: undefined,
    });
  });

  it('sends only grounding fields to question drafting', async () => {
    await httpBackendClient.answerQuestions(profile, jobInfo, []);

    expect(callBackend).toHaveBeenCalledWith('/answer-questions', expect.anything(), {
      body: {
        profile: {
          workExperience: profile.workExperience,
          education: profile.education,
          skills: profile.skills,
          stories: profile.stories,
          // Prepared answers, so a question whose wording matched none of them is still drafted from
          // what the candidate has already written rather than invented beside it. `screeningAnswers`
          // stays behind: a legal declaration is matched, never drafted.
          customAnswers: profile.customAnswers,
        },
        jobInfo,
        questions: [],
      },
      signal: undefined,
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
      rawDescription: null,
      extractionVersion: null,
      requirementEvidence: null,
      bulletProvenance: null,
    });

    expect(callBackend).toHaveBeenCalledWith(
      '/applications/a%20b%2Fc?response=compact',
      expect.anything(),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('encodes the job URL into the duplicate-lookup query', async () => {
    vi.mocked(callBackend).mockResolvedValue({ count: 0, latest: null });
    await expect(
      httpBackendClient.findApplicationDuplicates('https://boards.example.com/j?id=1'),
    ).resolves.toEqual({ count: 0, latest: null });

    expect(callBackend).toHaveBeenCalledWith(
      '/applications?jobUrl=https%3A%2F%2Fboards.example.com%2Fj%3Fid%3D1&response=compact',
      expect.anything(),
      { method: 'GET', signal: undefined },
    );
  });

  it('forwards an analysis cancellation signal to the transport', async () => {
    const signal = new AbortController().signal;

    await httpBackendClient.extractJob('a posting', signal);

    expect(callBackend).toHaveBeenCalledWith('/extract-job', expect.anything(), {
      body: { jobDescription: 'a posting' },
      signal,
    });
  });

  it('parses a duplicate-lookup response with newest application metadata', async () => {
    const summary = {
      count: 2,
      latest: {
        id: 'application-2',
        company: 'Acme',
        roleTitle: 'Engineer',
        stage: 'phone_screen',
        createdAt: '2026-08-18T00:00:00.000Z',
      },
    };
    respondWith(summary);

    await expect(
      httpBackendClient.findApplicationDuplicates('https://boards.example.com/jobs/1'),
    ).resolves.toEqual(summary);
  });

  it.each([
    {
      count: 0,
      latest: {
        id: 'application-1',
        company: 'Acme',
        roleTitle: 'Engineer',
        stage: 'applied',
        createdAt: 'now',
      },
    },
    { count: 1, latest: null },
  ])('rejects a contradictory duplicate-lookup response: %o', async (summary) => {
    respondWith(summary);

    await expect(
      httpBackendClient.findApplicationDuplicates('https://boards.example.com/jobs/1'),
    ).rejects.toThrow(/latest must be/);
  });

  it('rejects a tailored resume that came back without its work experience', async () => {
    // The failure this whole response-decoding change exists for. A model-written payload used to be
    // cast to its return type unchecked, so a missing half arrived looking valid, was checkpointed
    // onto the run, and surfaced two steps later as an empty PDF and a Keyword Coverage report that
    // evidenced nothing — with nothing pointing back at the response that caused it.
    respondWith({ skills: ['TypeScript'] });

    await expect(httpBackendClient.tailorResume(profile, jobInfo)).rejects.toThrow();
  });

  it('rejects job info whose requirements came back as prose rather than a list', async () => {
    respondWith({ ...jobInfo, requirements: 'Five years of TypeScript' });

    await expect(httpBackendClient.extractJob('a posting')).rejects.toThrow();
  });

  it('rejects a drafted answer missing the field it belongs to, which nothing downstream could fill', async () => {
    respondWith([{ question: 'Why us?', answer: 'Because.', sourceStoryIds: [] }]);

    await expect(httpBackendClient.answerQuestions(profile, jobInfo, [])).rejects.toThrow();
  });

  it('reads an absent profile as null rather than failing on it', async () => {
    // `GET /profile` answers `null` for a candidate who hasn't set one up, which is a real answer.
    respondWith(null);

    await expect(httpBackendClient.getProfile()).resolves.toBeNull();
  });

  it('accepts the profile the backend actually stores, so the nullable schema is not too strict', async () => {
    respondWith(profile);

    await expect(httpBackendClient.getProfile()).resolves.toEqual(profile);
  });

  it('rejects a malformed optimized response instead of silently losing its id', async () => {
    respondWith({});

    await expect(
      httpBackendClient.saveApplication(
        {
          company: 'Acme',
          roleTitle: 'Engineer',
          jobUrl: 'https://example.com/job',
          jobInfo,
          tailoredResume,
          answers: [],
        },
        'idempotency-key-1',
      ),
    ).rejects.toThrow();

    expect(callBackend).toHaveBeenCalledWith(
      '/applications?response=compact',
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'idempotency-key-1' }),
    );
  });
});

describe('httpBackendClient.answerChat', () => {
  it('sends a cold ask with the answer-grounding profile projection and an empty thread', async () => {
    await httpBackendClient.answerChat({
      profile,
      question: 'Why do you want to work here?',
      messages: [],
    });

    expect(callBackend).toHaveBeenCalledWith('/answer-chat', expect.anything(), {
      body: {
        profile: {
          workExperience: profile.workExperience,
          education: profile.education,
          skills: profile.skills,
          stories: profile.stories,
          customAnswers: profile.customAnswers,
        },
        question: 'Why do you want to work here?',
        messages: [],
      },
    });
  });

  it('sends the job and the seeded draft when the thread came from a question card', async () => {
    await httpBackendClient.answerChat({
      profile,
      question: 'Why do you want to work here?',
      jobInfo,
      currentAnswer: 'A first draft.',
      messages: [{ role: 'user', content: 'Make it shorter.' }],
    });

    expect(callBackend).toHaveBeenCalledWith(
      '/answer-chat',
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          jobInfo,
          currentAnswer: 'A first draft.',
          messages: [{ role: 'user', content: 'Make it shorter.' }],
        }),
      }),
    );
  });

  it("omits the job key entirely when there's no run to take one from", async () => {
    // The wire contract's absent job is a missing key, not `null` — sending the panel's `null`
    // straight through would fail validation at the route with nothing on screen explaining why.
    await httpBackendClient.answerChat({
      profile,
      question: 'Why us?',
      jobInfo: null,
      messages: [],
    });

    expect(vi.mocked(callBackend).mock.calls[0][2]?.body).not.toHaveProperty('jobInfo');
  });
});

/**
 * What must not leave the browser.
 *
 * Each of these four routes takes a *projection* of the Profile — the fields that ground one model
 * call — and the projection is stated once, as a `.pick` in `@djobi/shared`'s `wire.ts`. These
 * cases name the fields that stay behind, so widening one of those picks fails here rather than
 * quietly starting to send a phone number to a model.
 *
 * They are worth having beside the exact-body cases above, which would also catch a leak: those
 * read as "this is the body", and this reads as "this is the rule". A `satisfies` annotation, which
 * is what these bodies used to be built with, passes both readings and enforces neither — a full
 * Profile is structurally assignable to every one of these narrow types.
 */
describe('Profile projections', () => {
  /** A Profile with something in every field a projection is supposed to leave behind. */
  const disclosing: Profile = {
    ...profile,
    phone: '+1 555 0100',
    location: 'Berlin, Germany',
    screeningAnswers: { work_authorization: 'Yes', sponsorship_required: 'No' },
    customAnswers: [{ question: 'Why us?', answer: 'Because of the product.' }],
    skills: ['TypeScript'],
  };

  /** Every key in a body, at any depth, so a field nested under `profile` is caught too. */
  function keysIn(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysIn);
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, member]) => [key, ...keysIn(member)]);
  }

  /**
   * The Profile projection a route actually sent.
   *
   * Scoped to the `profile` half rather than the whole body on purpose: a Job Info carries its own
   * `location`, and asserting over the body would make this pass or fail on the *job's* fields.
   */
  async function profileSentBy(send: () => Promise<unknown>, binary = false): Promise<unknown> {
    await send();
    const call = binary
      ? vi.mocked(callBackendBinary).mock.calls[0]
      : vi.mocked(callBackend).mock.calls[0];
    const body = binary ? call[1] : (call[2] as { body: unknown }).body;
    return (body as { profile: unknown }).profile;
  }

  it('grounds tailoring in work history alone — no contact details, no screening declarations', async () => {
    const sent = await profileSentBy(() => httpBackendClient.tailorResume(disclosing, jobInfo));

    expect(keysIn(sent)).not.toContain('phone');
    expect(keysIn(sent)).not.toContain('location');
    expect(keysIn(sent)).not.toContain('email');
    expect(keysIn(sent)).not.toContain('screeningAnswers');
    expect(keysIn(sent)).not.toContain('customAnswers');
  });

  it.each([
    ['answerQuestions', () => httpBackendClient.answerQuestions(disclosing, jobInfo, [])],
    [
      'answerChat',
      () => httpBackendClient.answerChat({ profile: disclosing, question: 'Why?', messages: [] }),
    ],
  ])('keeps contact details and screening declarations out of %s', async (_name, send) => {
    const sent = await profileSentBy(send);

    // A screening answer is a legal declaration, matched onto a form's own options by
    // `splitPreparedQuestions` and never handed to a model to draft around.
    expect(keysIn(sent)).not.toContain('screeningAnswers');
    expect(keysIn(sent)).not.toContain('phone');
    expect(keysIn(sent)).not.toContain('email');
    expect(keysIn(sent)).not.toContain('fullName');
  });

  it('sends the PDF renderer contact details and no stories', async () => {
    // The one route that *should* see them: they are printed in the resume header. Stated here so
    // the rule above reads as a projection rather than as "never send contact details".
    const sent = await profileSentBy(
      () => httpBackendClient.renderResumePdf(disclosing, tailoredResume),
      true,
    );

    expect(keysIn(sent)).toContain('phone');
    expect(keysIn(sent)).toContain('location');
    expect(keysIn(sent)).not.toContain('stories');
    expect(keysIn(sent)).not.toContain('screeningAnswers');
  });
});
