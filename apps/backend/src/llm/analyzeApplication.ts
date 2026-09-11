import type {
  AnalyzeApplicationProfile,
  JobInfo,
  QuestionAnswer,
  QuestionForModel,
  TailoredResume,
} from '@djobi/shared';
import { answerQuestions } from './answerQuestions.js';
import { extractJob } from './extractJob.js';
import { tailorResume } from './tailorResume.js';

export interface AnalyzeApplicationResult {
  jobInfo: JobInfo;
  tailoredResume: TailoredResume;
  answers: QuestionAnswer[];
}

/**
 * The Analysis Step's own sequencing — extract Job Info, then tailor a Resume and draft Question
 * Answers from it in parallel — moved server-side so it costs one round trip instead of three, and
 * the Profile crosses the wire once instead of once per operation.
 *
 * **Deliberately not the whole Analysis Step.** Classifying a page's fields into questions, the
 * prepared-answer split, which questions are worth a model call, reconstructing page order, and
 * measuring Keyword Coverage all stay in `background/applicationPipeline.ts` — every one of them
 * depends on Detected Fields, a page-specific concept this backend has no way to see, or on the
 * candidate's full Profile, which this operation's own narrow grounding (`AnalyzeApplicationProfile`)
 * deliberately does not carry. `questions` here is already the caller's filtered, model-worthy
 * subset; this function asks the model nothing about which questions those should be.
 *
 * `tailorResume` and `answerQuestions` each still narrow `profile` to their own picks before
 * building a prompt (see their own doc comments), so passing the wider `AnalyzeApplicationProfile`
 * to both is safe — this function does not have to project it further itself.
 */
export async function analyzeApplication(
  jobDescription: string,
  profile: AnalyzeApplicationProfile,
  questions: QuestionForModel[],
  signal?: AbortSignal,
): Promise<AnalyzeApplicationResult> {
  const jobInfo = await extractJob(jobDescription, signal);

  const [tailoredResumeResult, answers] = await Promise.all([
    tailorResume(profile, jobInfo, signal),
    answerQuestions(profile, jobInfo, questions, signal),
  ]);

  return { jobInfo, tailoredResume: tailoredResumeResult, answers };
}
