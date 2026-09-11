/**
 * `analyzeApplication`'s own sequencing — extract, then tailor and draft in parallel — tested
 * against its three collaborators directly rather than through the model, since the sequencing is
 * the behaviour under test here and each collaborator's own prompt/parse/retry behaviour is already
 * covered where it lives (`extractJob.test.ts`, `tailorResume.test.ts`, `answerQuestions.test.ts`).
 */
import type { AnalyzeApplicationProfile, JobInfo, QuestionForModel } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { extractJob, tailorResume, answerQuestions } = vi.hoisted(() => ({
  extractJob: vi.fn(),
  tailorResume: vi.fn(),
  answerQuestions: vi.fn(),
}));

vi.mock('./extractJob.js', () => ({ extractJob }));
vi.mock('./tailorResume.js', () => ({ tailorResume }));
vi.mock('./answerQuestions.js', () => ({ answerQuestions }));

const { analyzeApplication } = await import('./analyzeApplication.js');

const profile: AnalyzeApplicationProfile = {
  workExperience: [],
  education: [],
  maxBulletsPerRole: 6,
  skills: ['TypeScript'],
  stories: [],
  customAnswers: [],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Engineer',
  seniority: null,
  location: null,
  requirements: [],
  keywords: [],
};

const questions: QuestionForModel[] = [
  { fieldId: 'f-why', question: 'Why us?', options: undefined },
];

beforeEach(() => {
  extractJob.mockReset().mockResolvedValue(jobInfo);
  tailorResume.mockReset().mockResolvedValue({ skills: ['TypeScript'], workExperience: [] });
  answerQuestions.mockReset().mockResolvedValue([]);
});

describe('analyzeApplication', () => {
  it('extracts Job Info first, then tailors and drafts from it', async () => {
    const order: string[] = [];
    extractJob.mockImplementation(async () => {
      order.push('extractJob');
      return jobInfo;
    });
    tailorResume.mockImplementation(async () => {
      order.push('tailorResume');
      return { skills: [], workExperience: [] };
    });
    answerQuestions.mockImplementation(async () => {
      order.push('answerQuestions');
      return [];
    });

    await analyzeApplication('A posting.', profile, questions);

    expect(order[0]).toBe('extractJob');
    expect(order).toContain('tailorResume');
    expect(order).toContain('answerQuestions');
  });

  it('runs tailorResume and answerQuestions in parallel, not one after the other', async () => {
    let tailorStarted = false;
    let answerQuestionsSawTailorInFlight = false;
    tailorResume.mockImplementation(async () => {
      tailorStarted = true;
      return { skills: [], workExperience: [] };
    });
    answerQuestions.mockImplementation(async () => {
      answerQuestionsSawTailorInFlight = tailorStarted;
      return [];
    });

    await analyzeApplication('A posting.', profile, questions);

    // Both calls start on the same microtask turn, before either's mock has resolved — so by the
    // time answerQuestions' mock runs, tailorResume's has already been invoked (started, not
    // necessarily finished), which a sequential `await tailorResume(); await answerQuestions();`
    // could not produce.
    expect(answerQuestionsSawTailorInFlight).toBe(true);
  });

  it('passes the extracted Job Info to both tailorResume and answerQuestions', async () => {
    await analyzeApplication('A posting.', profile, questions);

    expect(tailorResume).toHaveBeenCalledWith(profile, jobInfo, undefined);
    expect(answerQuestions).toHaveBeenCalledWith(profile, jobInfo, questions, undefined);
  });

  it('forwards the abort signal to every call', async () => {
    const controller = new AbortController();

    await analyzeApplication('A posting.', profile, questions, controller.signal);

    expect(extractJob).toHaveBeenCalledWith('A posting.', controller.signal);
    expect(tailorResume).toHaveBeenCalledWith(profile, jobInfo, controller.signal);
    expect(answerQuestions).toHaveBeenCalledWith(profile, jobInfo, questions, controller.signal);
  });

  it('returns the combined result of all three calls', async () => {
    tailorResume.mockResolvedValue({ skills: ['Rust'], workExperience: [] });
    answerQuestions.mockResolvedValue([
      { fieldId: 'f-why', question: 'Why us?', answer: 'Because.', sourceStoryIds: [] },
    ]);

    const result = await analyzeApplication('A posting.', profile, questions);

    expect(result).toEqual({
      jobInfo,
      tailoredResume: { skills: ['Rust'], workExperience: [] },
      answers: [{ fieldId: 'f-why', question: 'Why us?', answer: 'Because.', sourceStoryIds: [] }],
    });
  });

  it('never calls tailorResume or answerQuestions when extractJob fails', async () => {
    extractJob.mockRejectedValue(new Error('model unavailable'));

    await expect(analyzeApplication('A posting.', profile, questions)).rejects.toThrow(
      'model unavailable',
    );
    expect(tailorResume).not.toHaveBeenCalled();
    expect(answerQuestions).not.toHaveBeenCalled();
  });

  it('propagates a failure from either the tailoring or the drafting call', async () => {
    answerQuestions.mockRejectedValue(new Error('answer-questions failed'));

    await expect(analyzeApplication('A posting.', profile, questions)).rejects.toThrow(
      'answer-questions failed',
    );
  });
});
