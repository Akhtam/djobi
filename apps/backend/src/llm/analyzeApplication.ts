import type {
  AnalyzeApplicationProfile,
  AnalyzeApplicationResponse,
  QuestionForModel,
} from '@djobi/shared';
import { answerQuestions } from './answerQuestions.js';
import { extractJob } from './extractJob.js';
import { tailorResume } from './tailorResume.js';

/**
 * The Analysis Step's model work in one round trip: extract Job Info, then tailor the resume and
 * draft answers in parallel.
 *
 * Field classification, the prepared-answer split, question filtering and Keyword Coverage stay in
 * the extension's `applicationPipeline.ts` — they need Detected Fields or the full Profile, which
 * this route never sees. `tailorResume`/`answerQuestions` each narrow `profile` to their own
 * projection.
 */
export async function analyzeApplication(
  jobDescription: string,
  profile: AnalyzeApplicationProfile,
  questions: QuestionForModel[],
  signal?: AbortSignal,
): Promise<AnalyzeApplicationResponse> {
  const jobInfo = await extractJob(jobDescription, signal);

  const [tailoredResumeResult, answers] = await Promise.all([
    tailorResume(profile, jobInfo, signal),
    answerQuestions(profile, jobInfo, questions, signal),
  ]);

  return { jobInfo, tailoredResume: tailoredResumeResult, answers };
}
