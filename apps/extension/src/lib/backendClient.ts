/**
 * The local backend's routes as typed calls, and the only place in the extension that names a
 * backend path.
 *
 * Each method builds its body against the shared request schema from `@djobi/shared`'s `wire.ts` —
 * the same schema the route parses — via `satisfies`. That is what this module is for: it turns a
 * drift between what the extension sends and what the backend accepts into a compile error, in the
 * one place where the two halves meet. They used to be related only by both being written
 * correctly, and when that stopped being true (a `knownAnswer` the route's private schema didn't
 * declare, silently stripped by zod) nothing on either side could notice.
 *
 * `callBackend` still exists underneath for the routes that aren't part of the Application
 * Pipeline — the panel and options page read and write the Profile through it directly.
 */
import type {
  AnswerQuestionsRequest,
  Application,
  ApplicationSnapshot,
  ExtractJobRequest,
  JobInfo,
  NewApplication,
  Profile,
  QuestionAnswer,
  QuestionForModel,
  RenderResumePdfRequest,
  TailorResumeRequest,
  TailoredResume,
} from '@djobi/shared';
import { callBackend, callBackendBinary } from './callBackend';

/** The backend-facing half of the Application Pipeline's outside world. */
export interface BackendClient {
  extractJob(jobDescription: string): Promise<JobInfo>;
  tailorResume(profile: Profile, jobInfo: JobInfo): Promise<TailoredResume>;
  answerQuestions(
    profile: Profile,
    jobInfo: JobInfo,
    questions: QuestionForModel[],
  ): Promise<QuestionAnswer[]>;
  renderResumePdf(profile: Profile, tailoredResume: TailoredResume): Promise<ArrayBuffer>;
  saveApplication(payload: NewApplication): Promise<Application>;
  updateApplication(id: string, payload: ApplicationSnapshot): Promise<Application>;
  /** Past applications to this exact job URL, most recent first. Empty when it's a new posting. */
  findApplicationsByJobUrl(jobUrl: string): Promise<Application[]>;
}

/** The production adapter: the local Hono server on `127.0.0.1:5391`. */
export const httpBackendClient: BackendClient = {
  extractJob: (jobDescription) =>
    callBackend('/extract-job', { jobDescription } satisfies ExtractJobRequest),

  tailorResume: (profile, jobInfo) =>
    callBackend('/tailor-resume', { profile, jobInfo } satisfies TailorResumeRequest),

  answerQuestions: (profile, jobInfo, questions) =>
    callBackend('/answer-questions', {
      profile,
      jobInfo,
      questions,
    } satisfies AnswerQuestionsRequest),

  renderResumePdf: (profile, tailoredResume) =>
    callBackendBinary('/render-resume-pdf', {
      profile,
      tailoredResume,
    } satisfies RenderResumePdfRequest),

  saveApplication: (payload) => callBackend<Application>('/applications', payload),

  updateApplication: (id, payload) =>
    callBackend<Application>(`/applications/${encodeURIComponent(id)}`, payload, 'PATCH'),

  findApplicationsByJobUrl: (jobUrl) =>
    callBackend<Application[]>(
      `/applications?jobUrl=${encodeURIComponent(jobUrl)}`,
      undefined,
      'GET',
    ),
};
