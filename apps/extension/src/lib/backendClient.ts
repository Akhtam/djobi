/**
 * The backend's routes as typed calls — the only place in the extension that names a backend path.
 *
 * Request bodies are **parsed** through the shared `wire.ts` schemas, never `satisfies`-checked:
 * a full Profile is assignable to every narrow projection type, so only parsing actually drops the
 * fields a route shouldn't receive (phone, location, screening answers). Widening a projection's
 * `.pick` is therefore a disclosure change; `backendClient.test.ts` asserts the excluded fields.
 * Every response is decoded through its schema too.
 */
import {
  AnalyzeApplicationRequestSchema,
  AnalyzeApplicationResponseSchema,
  AnswerChatRequestSchema,
  AnswerChatResponseSchema,
  ApplicationWriteResultSchema,
  baseResumeOf,
  RenderResumePdfRequestSchema,
  type AnalyzeApplicationResponse,
  type AnswerChatResponse,
  type ApplicationSnapshot,
  type ChatMessage,
  type ApplicationWriteResult,
  type JobInfo,
  type NewApplicationRequest,
  type Profile,
  type QuestionForModel,
  type TailoredResume,
} from '@djobi/shared';
import { backendRoutes, requestBody, type BackendRoutes } from '@djobi/http-client';
import { signIn as authSignIn, signOut as authSignOut, withSharedSessionRetry } from './authClient';
import { HttpError, transport } from './callBackend';

/**
 * One Ask-tab turn. `jobInfo` is nullable: a chat is possible before any analysis.
 */
export interface AnswerChatTurn {
  profile: Profile;
  question: string;
  jobInfo?: JobInfo | null | undefined;
  /** The draft being refined, when the thread was seeded from a question card. */
  currentAnswer?: string | undefined;
  /** The thread so far, empty on a cold ask, ending with the candidate's new message. */
  messages: ChatMessage[];
}

/** Routes the dashboard calls identically, from `@djobi/http-client`'s `backendRoutes`. */
const sharedRoutes = backendRoutes(transport);

/**
 * The backend-facing half of the Application Pipeline's outside world. The shared routes' contract
 * is `BackendRoutes`'s; `extractJob` serves the Log tab (`panel/LogApplication.tsx`), which never
 * tailors.
 */
export interface BackendClient extends Pick<
  BackendRoutes,
  'extractJob' | 'getProfile' | 'saveProfile' | 'extractResume' | 'findApplicationDuplicates'
> {
  /**
   * The Analysis Step in one `POST /analyze` round trip. The sequencing is the backend's; a fake
   * answers with the whole response.
   */
  analyzeApplication(
    jobDescription: string,
    profile: Profile,
    questions: QuestionForModel[],
    signal?: AbortSignal,
  ): Promise<AnalyzeApplicationResponse>;
  /** One turn of the Ask tab's conversation — cold ask and refinement alike. */
  answerChat(turn: AnswerChatTurn): Promise<AnswerChatResponse>;
  renderResumePdf(
    profile: Profile,
    tailoredResume: TailoredResume,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
  /**
   * `idempotencyKey` must be the same across retries of one save (the pipeline uses the run id, the
   * Log tab one key per extraction), so a resend after a timeout returns the same row.
   */
  saveApplication(
    payload: NewApplicationRequest,
    idempotencyKey: string,
  ): Promise<ApplicationWriteResult>;
  updateApplication(id: string, payload: ApplicationSnapshot): Promise<ApplicationWriteResult>;
  /** Establishes a session, storing the bearer token every other method here then attaches. */
  signIn(email: string, password: string): Promise<void>;
  /** Ends the session, backend-side and locally. */
  signOut(): Promise<void>;
}

/**
 * The plain HTTP adapter, before {@link withSessionRecovery}. Shared routes come from
 * `backendRoutes`; the rest call `transport` directly with an explicit `method`.
 */
const rawHttpBackendClient: BackendClient = {
  extractJob: sharedRoutes.extractJob,

  analyzeApplication: (jobDescription, profile, questions, signal) =>
    transport.json('/analyze', AnalyzeApplicationResponseSchema, {
      method: 'POST',
      body: requestBody('/analyze', AnalyzeApplicationRequestSchema, {
        jobDescription,
        profile,
        questions,
      }),
      signal,
      // `/analyze` chains extraction then tailoring/answering, so it gets a longer budget than the
      // default. 150s leaves headroom over measured times while keeping hangs retryable.
      timeoutMs: 150_000,
    }),

  answerChat: ({ profile, question, jobInfo, currentAnswer, messages }) =>
    transport.json('/answer-chat', AnswerChatResponseSchema, {
      method: 'POST',
      body: requestBody('/answer-chat', AnswerChatRequestSchema, {
        profile,
        question,
        // `null` is the panel's "no run yet"; the wire contract's absent job is `undefined`, and an
        // omitted key is not a job whose every field is unknown.
        ...(jobInfo ? { jobInfo } : {}),
        ...(currentAnswer ? { currentAnswer } : {}),
        messages,
      }),
    }),

  renderResumePdf: (profile, tailoredResume, signal) =>
    transport.binary('/render-resume-pdf', {
      method: 'POST',
      body: requestBody('/render-resume-pdf', RenderResumePdfRequestSchema, {
        profile,
        tailoredResume,
      }),
      signal,
    }),

  getProfile: sharedRoutes.getProfile,
  saveProfile: sharedRoutes.saveProfile,
  extractResume: sharedRoutes.extractResume,

  saveApplication: (payload, idempotencyKey) =>
    transport.json('/applications?response=compact', ApplicationWriteResultSchema, {
      method: 'POST',
      body: payload,
      idempotencyKey,
    }),

  updateApplication: (id, payload) =>
    transport.json(
      `/applications/${encodeURIComponent(id)}?response=compact`,
      ApplicationWriteResultSchema,
      { method: 'PATCH', body: payload },
    ),

  findApplicationDuplicates: sharedRoutes.findApplicationDuplicates,

  signIn: authSignIn,
  signOut: authSignOut,
};

/** Every `BackendClient` method {@link withSessionRecovery} wraps: all but `signIn`/`signOut`. */
type RecoveredMethod = Exclude<keyof BackendClient, 'signIn' | 'signOut'>;

/**
 * The wrapped methods, listed explicitly. `satisfies` rejects a non-method name and
 * `AllRecoveredMethodsListed` rejects a missing one, so a new method can't ship unwrapped.
 */
const RECOVERED_METHODS = [
  'extractJob',
  'analyzeApplication',
  'answerChat',
  'renderResumePdf',
  'getProfile',
  'saveProfile',
  'extractResume',
  'saveApplication',
  'updateApplication',
  'findApplicationDuplicates',
] as const satisfies readonly RecoveredMethod[];

/**
 * `never` exactly when every {@link RecoveredMethod} appears in {@link RECOVERED_METHODS}.
 * Assigning it below turns an omission into a compile error naming the method left out.
 */
type AllRecoveredMethodsListed = Exclude<RecoveredMethod, (typeof RECOVERED_METHODS)[number]>;
const _allRecoveredMethodsListed: AllRecoveredMethodsListed[] = [];
void _allRecoveredMethodsListed;

/**
 * Wraps every method but `signIn`/`signOut` in `retry` (default: adopt the dashboard's session and
 * retry once on a 401). Applied at the `BackendClient` interface, not the transport, so fakes and
 * every caller (panel, options, worker) get it. `signIn`/`signOut` are excluded: they establish and
 * end sessions. `retry` is injectable for tests.
 */
export function withSessionRecovery(
  client: BackendClient,
  retry: <T>(attempt: () => Promise<T>) => Promise<T> = withSharedSessionRetry,
): BackendClient {
  /**
   * Wraps one method, forwarding exactly the caller's arguments. `client[method]` is read at call
   * time, so a test reassigning a method on the client still reaches the wrapper.
   */
  function recovered<Method extends keyof BackendClient>(method: Method): BackendClient[Method] {
    return ((...args: unknown[]) => {
      const call = client[method] as (...callArgs: unknown[]) => Promise<unknown>;
      return retry(() => call(...args));
    }) as BackendClient[Method];
  }

  const wrapped = Object.fromEntries(
    RECOVERED_METHODS.map((method) => [method, recovered(method)]),
  ) as Pick<BackendClient, RecoveredMethod>;

  return { ...client, ...wrapped };
}

/** The production adapter: the local Hono server on `127.0.0.1:5391`, with session recovery. */
export const httpBackendClient: BackendClient = withSessionRecovery(rawHttpBackendClient);

const FAKE_JOB_INFO: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Engineer',
  seniority: null,
  location: null,
  requirements: [],
  keywords: [],
};

/** What `signIn` accepts against a fake client that was never given its own credentials. */
const FAKE_EMAIL = 'jane@example.com';
const FAKE_PASSWORD = 'correct horse battery staple';

/**
 * How a fake client's session starts and which credentials `signIn` accepts. `signedIn` defaults
 * to `true`; sign-in and mid-run-401 tests opt out.
 */
export interface FakeBackendAuthOptions {
  signedIn?: boolean;
  email?: string;
  password?: string;
}

/**
 * A `BackendClient` for tests: every route answered from memory, each overridable — so panel and
 * options pages are tested end to end at the production seam. Never wired into `main.tsx`: a flag
 * swapping in fake data could be left on.
 */
export function createFakeBackendClient(
  overrides: Partial<BackendClient> = {},
  auth: FakeBackendAuthOptions = {},
): BackendClient {
  const { signedIn = true, email = FAKE_EMAIL, password = FAKE_PASSWORD } = auth;
  let hasSession = signedIn;

  /** A real `requireAuth` 401, in the `HttpError` shape callers classify. */
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
    extractJob: guarded('/extract-job', () => Promise.resolve(FAKE_JOB_INFO)),
    // A whole `/analyze` response: the Profile's resume untailored and a stock draft per question.
    analyzeApplication: guarded(
      '/analyze',
      (_jobDescription: string, profile: Profile, questions: QuestionForModel[]) =>
        Promise.resolve({
          jobInfo: FAKE_JOB_INFO,
          tailoredResume: baseResumeOf(profile),
          answers: questions.map((question) => ({
            fieldId: question.fieldId,
            question: question.question,
            answer: question.knownAnswer ?? 'Draft answer.',
            sourceStoryIds: [],
          })),
        }),
    ),
    answerChat: guarded('/answer-chat', () => Promise.resolve({ reply: 'Here you go.' })),
    // Four bytes of `%PDF`, which is all any caller here does anything with.
    renderResumePdf: guarded('/render-resume-pdf', () =>
      Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer),
    ),
    getProfile: guarded('/profile', () => Promise.resolve(null)),
    saveProfile: guarded('/profile', (profile: Profile) => Promise.resolve(profile)),
    extractResume: guarded('/profile/extract-resume', () =>
      Promise.resolve({
        fullName: 'Jane Doe',
        email: 'jane@example.com',
        phone: null,
        location: null,
        links: { linkedin: null, portfolio: null, github: null },
        summary: null,
        workExperience: [],
        education: [],
        skills: [],
        projects: [],
        certifications: [],
        awards: [],
      }),
    ),
    saveApplication: guarded(
      '/applications',
      (_payload: NewApplicationRequest, _idempotencyKey: string) =>
        Promise.resolve({ id: 'application-1' }),
    ),
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
