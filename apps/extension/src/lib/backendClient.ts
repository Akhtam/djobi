/**
 * The local backend's routes as typed calls, and the only place in the extension that names a
 * backend path.
 *
 * Each method builds its body by **parsing** the shared request schema from `@djobi/shared`'s
 * `wire.ts` — the same schema the route parses. That is what this module is for: it turns a drift
 * between what the extension sends and what the backend accepts into a failure at the one place
 * where the two halves meet. They used to be related only by both being written correctly, and when
 * that stopped being true (a `knownAnswer` the route's private schema didn't declare, silently
 * stripped by zod) nothing on either side could notice.
 *
 * **The parse is what minimizes what leaves the browser, and a `satisfies` cannot do it.** Three of
 * these routes take a *projection* of the Profile — the fields that ground one model call — and each
 * projection used to be spelled out here as an object literal, a second time as a `.pick` in
 * `wire.ts`, and a third time as a `relevantProfile` in the backend operation. `satisfies` checks
 * assignability and strips nothing: a full Profile is structurally assignable to every one of these
 * narrow types, so `{ profile, jobInfo } satisfies TailorResumeRequest` compiles and sends the
 * candidate's phone number, location and screening declarations to the model. `Schema.parse` builds
 * the body the schema describes and drops the rest, so the projection is enforced where it is
 * stated instead of being re-typed by hand at each end.
 *
 * Widening one of those `.pick`s is therefore a **disclosure change**: the field starts crossing to
 * the backend and reaching the model with no further edit. `backendClient.test.ts` asserts the
 * absent ones by name.
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
  AnswerChatRequestSchema,
  AnswerChatResponseSchema,
  AnswerQuestionsRequestSchema,
  ApplicationWriteResultSchema,
  baseResumeOf,
  DuplicateApplicationSummarySchema,
  ExtractJobRequestSchema,
  JobInfoSchema,
  ProfileSchema,
  QuestionAnswerSchema,
  RenderResumePdfRequestSchema,
  TailorResumeRequestSchema,
  TailoredResumeSchema,
  type AnswerChatResponse,
  type ApplicationSnapshot,
  type ChatMessage,
  type ApplicationWriteResult,
  type DuplicateApplicationSummary,
  type JobInfo,
  type NewApplicationRequest,
  type Profile,
  type QuestionAnswer,
  type QuestionForModel,
  type SaveProfileRequest,
  type TailoredResume,
} from '@djobi/shared';
import { signIn as authSignIn, signOut as authSignOut } from './authClient';
import { callBackend, callBackendBinary, HttpError } from './callBackend';

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
  renderResumePdf(
    profile: Profile,
    tailoredResume: TailoredResume,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
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
  /** Establishes a session, storing the bearer token every other method here then attaches. */
  signIn(email: string, password: string): Promise<void>;
  /** Ends the session, backend-side and locally. */
  signOut(): Promise<void>;
}

/** The production adapter: the local Hono server on `127.0.0.1:5391`. */
export const httpBackendClient: BackendClient = {
  extractJob: (jobDescription, signal) =>
    callBackend(
      '/extract-job',
      JobInfoSchema,
      ExtractJobRequestSchema.parse({ jobDescription }),
      'POST',
      signal,
    ),

  tailorResume: (profile, jobInfo, signal) =>
    callBackend(
      '/tailor-resume',
      TailoredResumeSchema,
      TailorResumeRequestSchema.parse({ profile, jobInfo }),
      'POST',
      signal,
    ),

  answerQuestions: (profile, jobInfo, questions, signal) =>
    callBackend(
      '/answer-questions',
      QuestionAnswerSchema.array(),
      AnswerQuestionsRequestSchema.parse({ profile, jobInfo, questions }),
      'POST',
      signal,
    ),

  answerChat: ({ profile, question, jobInfo, currentAnswer, messages }) =>
    callBackend(
      '/answer-chat',
      AnswerChatResponseSchema,
      AnswerChatRequestSchema.parse({
        profile,
        question,
        // `null` is the panel's "no run yet"; the wire contract's absent job is `undefined`, and an
        // omitted key is not a job whose every field is unknown.
        ...(jobInfo ? { jobInfo } : {}),
        ...(currentAnswer ? { currentAnswer } : {}),
        messages,
      }),
    ),

  renderResumePdf: (profile, tailoredResume, signal) =>
    callBackendBinary(
      '/render-resume-pdf',
      RenderResumePdfRequestSchema.parse({ profile, tailoredResume }),
      signal,
    ),

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

  signIn: authSignIn,
  signOut: authSignOut,
};

/** What `signIn` accepts against a fake client that was never given its own credentials. */
const FAKE_EMAIL = 'jane@example.com';
const FAKE_PASSWORD = 'correct horse battery staple';

/**
 * How a fake client's session starts, and what credentials `signIn` accepts against it.
 *
 * `signedIn` defaults to `true` — most of this suite drives the panel and options page past login,
 * the same reasoning `apps/dashboard`'s `FixtureAuthOptions` states for its own default. A test of
 * the sign-in flow itself, or of a 401 mid-run (`docs/multi-tenant-auth.md`, Phase D), is the one
 * that opts out.
 */
export interface FakeBackendAuthOptions {
  signedIn?: boolean;
  email?: string;
  password?: string;
}

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
export function createFakeBackendClient(
  overrides: Partial<BackendClient> = {},
  auth: FakeBackendAuthOptions = {},
): BackendClient {
  const { signedIn = true, email = FAKE_EMAIL, password = FAKE_PASSWORD } = auth;
  let hasSession = signedIn;

  /**
   * `requireAuth()`'s own answer, reproduced here — every route below sits behind it in `app.ts`,
   * so a fake that never rejects would let a test drive a signed-out UI as if it didn't exist.
   * `HttpError`'s `kind`/`status` are what `background/pipelineFailure.ts` and
   * `useApplicationStore`-style consumers actually switch on, so this has to be the same shape a
   * real 401 arrives in.
   */
  function unauthorized<T>(path: string): Promise<T> {
    return Promise.reject(
      new HttpError('http', path, `${path} failed (401): Authentication required`, 401),
    );
  }

  /** Gates one route behind `hasSession`, so every fake method states its own path once. */
  function guarded<Args extends unknown[], T>(
    path: string,
    respond: (...args: Args) => Promise<T>,
  ): (...args: Args) => Promise<T> {
    return (...args) => (hasSession ? respond(...args) : unauthorized<T>(path));
  }

  const fake: BackendClient = {
    extractJob: guarded('/extract-job', () =>
      Promise.resolve({
        company: 'Acme',
        team: null,
        roleTitle: 'Engineer',
        seniority: null,
        location: null,
        requirements: [],
        keywords: [],
      }),
    ),
    tailorResume: guarded('/tailor-resume', (profile: Profile) =>
      Promise.resolve(baseResumeOf(profile)),
    ),
    answerQuestions: guarded(
      '/answer-questions',
      (_profile: Profile, _jobInfo: JobInfo, questions: QuestionForModel[]) =>
        Promise.resolve(
          questions.map((question) => ({
            fieldId: question.fieldId,
            question: question.question,
            answer: question.knownAnswer ?? 'Draft answer.',
            sourceStoryIds: [],
          })),
        ),
    ),
    answerChat: guarded('/answer-chat', () => Promise.resolve({ reply: 'Here you go.' })),
    // Four bytes of `%PDF`, which is all any caller here does anything with.
    renderResumePdf: guarded('/render-resume-pdf', () =>
      Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer),
    ),
    getProfile: guarded('/profile', () => Promise.resolve(null)),
    saveProfile: guarded('/profile', (profile: Profile) => Promise.resolve(profile)),
    saveApplication: guarded('/applications', () => Promise.resolve({ id: 'application-1' })),
    updateApplication: guarded('/applications', () => Promise.resolve({ id: 'application-1' })),
    findApplicationDuplicates: guarded('/applications', () =>
      Promise.resolve({ count: 0, latest: null }),
    ),

    signIn: (attemptedEmail, attemptedPassword) => {
      if (attemptedEmail === email && attemptedPassword === password) {
        hasSession = true;
        return Promise.resolve();
      }
      return Promise.reject(
        new HttpError('http', '/api/auth/sign-in/email', 'Invalid email or password', 401),
      );
    },
    signOut: () => {
      hasSession = false;
      return Promise.resolve();
    },
  };

  return { ...fake, ...overrides };
}
