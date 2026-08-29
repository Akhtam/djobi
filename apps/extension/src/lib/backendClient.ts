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
 * The same guarantee now runs the other way too. `callBackend` takes the response schema as a
 * required argument, so every route here states what it expects back and gets it checked — where
 * before, eight of these eleven cast an unparsed body to their return type and only the three
 * simplest CRUD shapes were verified. The responses that went unchecked were exactly the ones a
 * model writes, whose failures surface furthest from their cause.
 *
 * `callBackend` is the transport underneath and is no longer called directly by anything that names
 * a path. It used to be: the panel and options page built `/profile` and `/render-resume-pdf` by
 * hand, so `/render-resume-pdf` existed twice — once here against `RenderResumePdfRequest`, once in
 * the panel against nothing. The guarantee this module exists to give is only as wide as the set of
 * call sites that go through it, so the Profile routes live here too and the claim above holds.
 */
import {
  AnswerChatResponseSchema,
  ApplicationWriteResultSchema,
  DuplicateApplicationSummarySchema,
  JobInfoSchema,
  ProfileSchema,
  QuestionAnswerSchema,
  TailoredResumeSchema,
  type AnswerChatRequest,
  type AnswerChatResponse,
  type AnswerQuestionsRequest,
  type ApplicationSnapshot,
  type ChatMessage,
  type ApplicationWriteResult,
  type DuplicateApplicationSummary,
  type ExtractJobRequest,
  type JobInfo,
  type NewApplicationRequest,
  type Profile,
  type QuestionAnswer,
  type QuestionForModel,
  type RenderResumePdfRequest,
  type SaveProfileRequest,
  type TailorResumeRequest,
  type TailoredResume,
} from '@djobi/shared';
import { callBackend, callBackendBinary } from './callBackend';

/**
 * What the Ask tab has to say to ask one turn. `jobInfo` is nullable rather than optional because
 * that is how the panel holds it — there is no run to take one from until analysis has produced
 * one, and a chat about a question is possible before then.
 */
export interface AnswerChatTurn {
  profile: Profile;
  question: string;
  jobInfo?: JobInfo | null;
  /** The draft being refined, when the thread was seeded from a question card. */
  currentAnswer?: string;
  /** The thread so far, empty on a cold ask, ending with the candidate's new message. */
  messages: ChatMessage[];
}

/**
 * What `GET /profile` answers with. Nullable rather than optional: `null` is the real answer for a
 * candidate who hasn't set a Profile up yet, not a missing response. Built once here rather than
 * inline at the call site, which would compose a fresh schema on every request.
 */
const MaybeProfileSchema = ProfileSchema.nullable();

/** The backend-facing half of the Application Pipeline's outside world. */
export interface BackendClient {
  extractJob(jobDescription: string, signal?: AbortSignal): Promise<JobInfo>;
  tailorResume(profile: Profile, jobInfo: JobInfo, signal?: AbortSignal): Promise<TailoredResume>;
  answerQuestions(
    profile: Profile,
    jobInfo: JobInfo,
    questions: QuestionForModel[],
    signal?: AbortSignal,
  ): Promise<QuestionAnswer[]>;
  /** One turn of the Ask tab's conversation — cold ask and refinement alike. */
  answerChat(turn: AnswerChatTurn): Promise<AnswerChatResponse>;
  renderResumePdf(profile: Profile, tailoredResume: TailoredResume): Promise<ArrayBuffer>;
  /** The single stored Profile, or `null` before the candidate has saved one. */
  getProfile(): Promise<Profile | null>;
  /** Stores the Profile whole and resolves with what was stored. */
  saveProfile(profile: Profile): Promise<Profile>;
  saveApplication(payload: NewApplicationRequest): Promise<ApplicationWriteResult>;
  updateApplication(id: string, payload: ApplicationSnapshot): Promise<ApplicationWriteResult>;
  /** Count and newest metadata for Applications saved against this exact job URL. */
  findApplicationDuplicates(
    jobUrl: string,
    signal?: AbortSignal,
  ): Promise<DuplicateApplicationSummary>;
}

/** The production adapter: the local Hono server on `127.0.0.1:5391`. */
export const httpBackendClient: BackendClient = {
  extractJob: (jobDescription, signal) =>
    callBackend(
      '/extract-job',
      JobInfoSchema,
      { jobDescription } satisfies ExtractJobRequest,
      'POST',
      signal,
    ),

  tailorResume: (profile, jobInfo, signal) =>
    callBackend(
      '/tailor-resume',
      TailoredResumeSchema,
      {
        profile: { workExperience: profile.workExperience, skills: profile.skills },
        jobInfo,
      } satisfies TailorResumeRequest,
      'POST',
      signal,
    ),

  answerQuestions: (profile, jobInfo, questions, signal) =>
    callBackend(
      '/answer-questions',
      QuestionAnswerSchema.array(),
      {
        profile: {
          workExperience: profile.workExperience,
          education: profile.education,
          skills: profile.skills,
          stories: profile.stories,
          customAnswers: profile.customAnswers,
        },
        jobInfo,
        questions,
      } satisfies AnswerQuestionsRequest,
      'POST',
      signal,
    ),

  answerChat: ({ profile, question, jobInfo, currentAnswer, messages }) =>
    callBackend('/answer-chat', AnswerChatResponseSchema, {
      profile: {
        workExperience: profile.workExperience,
        education: profile.education,
        skills: profile.skills,
        stories: profile.stories,
        // The Ask tab drafts an answer to an application question, same as `/answer-questions`, so
        // it grounds on the candidate's prepared answers for the same reason.
        customAnswers: profile.customAnswers,
      },
      question,
      // `null` is the panel's "no run yet"; the wire contract's absent job is `undefined`, and
      // `JSON.stringify` drops the key rather than sending a job whose every field is unknown.
      ...(jobInfo ? { jobInfo } : {}),
      ...(currentAnswer ? { currentAnswer } : {}),
      messages,
    } satisfies AnswerChatRequest),

  renderResumePdf: (profile, tailoredResume) =>
    callBackendBinary('/render-resume-pdf', {
      profile: {
        fullName: profile.fullName,
        email: profile.email,
        phone: profile.phone,
        location: profile.location,
        links: profile.links,
        education: profile.education,
      },
      tailoredResume,
    } satisfies RenderResumePdfRequest),

  getProfile: () => callBackend('/profile', MaybeProfileSchema, undefined, 'GET'),

  saveProfile: (profile) =>
    callBackend('/profile', ProfileSchema, profile satisfies SaveProfileRequest),

  saveApplication: (payload) =>
    callBackend('/applications?response=compact', ApplicationWriteResultSchema, payload),

  updateApplication: (id, payload) =>
    callBackend(
      `/applications/${encodeURIComponent(id)}?response=compact`,
      ApplicationWriteResultSchema,
      payload,
      'PATCH',
    ),

  findApplicationDuplicates: (jobUrl, signal) =>
    callBackend(
      `/applications?jobUrl=${encodeURIComponent(jobUrl)}&response=compact`,
      DuplicateApplicationSummarySchema,
      undefined,
      'GET',
      signal,
    ),
};

/**
 * A `BackendClient` for tests: every route answered from memory, each answer overridable.
 *
 * The extension's counterpart to `apps/dashboard`'s `createFixtureDashboardClient`, and it exists
 * for the same reason — the panel and options pages are exercised end to end with no network, at
 * the same seam production uses. Before it, their tests replaced `callBackend` instead and matched
 * on backend *paths* (`path === '/answer-chat'`), which is a test written against the transport:
 * it passes when the client sends the right URL and says nothing about whether the module asked for
 * the right thing.
 *
 * Not wired into either `main.tsx`, deliberately, for the reason the dashboard's comment gives: a
 * runtime flag that swaps the real backend for fake data is a flag that can be left on.
 */
export function createFakeBackendClient(overrides: Partial<BackendClient> = {}): BackendClient {
  const fake: BackendClient = {
    extractJob: () =>
      Promise.resolve({
        company: 'Acme',
        team: null,
        roleTitle: 'Engineer',
        seniority: null,
        location: null,
        requirements: [],
        keywords: [],
      }),
    tailorResume: (profile) =>
      Promise.resolve({ skills: profile.skills, workExperience: profile.workExperience }),
    answerQuestions: (_profile, _jobInfo, questions) =>
      Promise.resolve(
        questions.map((question) => ({
          fieldId: question.fieldId,
          question: question.question,
          answer: question.knownAnswer ?? 'Draft answer.',
          sourceStoryIds: [],
        })),
      ),
    answerChat: () => Promise.resolve({ reply: 'Here you go.' }),
    // Four bytes of `%PDF`, which is all any caller here does anything with.
    renderResumePdf: () => Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer),
    getProfile: () => Promise.resolve(null),
    saveProfile: (profile) => Promise.resolve(profile),
    saveApplication: () => Promise.resolve({ id: 'application-1' }),
    updateApplication: () => Promise.resolve({ id: 'application-1' }),
    findApplicationDuplicates: () => Promise.resolve({ count: 0, latest: null }),
  };

  return { ...fake, ...overrides };
}
