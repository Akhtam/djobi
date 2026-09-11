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
  AnalyzeApplicationRequestSchema,
  AnalyzeApplicationResponseSchema,
  AnswerChatRequestSchema,
  AnswerChatResponseSchema,
  AnswerQuestionsRequestSchema,
  ApplicationWriteResultSchema,
  baseResumeOf,
  DuplicateApplicationSummarySchema,
  ExtractJobRequestSchema,
  ExtractResumeResponseSchema,
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
  type ExtractedProfile,
  type JobInfo,
  type NewApplicationRequest,
  type Profile,
  type QuestionAnswer,
  type QuestionForModel,
  type SaveProfileRequest,
  type TailoredResume,
} from '@djobi/shared';
import { signIn as authSignIn, signOut as authSignOut, withSharedSessionRetry } from './authClient';
import { HttpError, transport } from './callBackend';

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

/** What {@link BackendClient.analyzeApplication} resolves with. */
export interface AnalyzeApplicationResult {
  jobInfo: JobInfo;
  tailoredResume: TailoredResume;
  answers: QuestionAnswer[];
}

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
  /**
   * The Analysis Step's own consolidated call: `extractJob`, then `tailorResume` and
   * `answerQuestions` from it in parallel, in one round trip against `POST /analyze` — see
   * `apps/backend/src/llm/analyzeApplication.ts`. `background/applicationPipeline.ts`'s
   * `analysisStep` is the one caller; `extractJob`/`tailorResume`/`answerQuestions` above stay on
   * this interface for the Log tab's `extractJob`-only call (`panel/LogApplication.tsx`), which
   * never tailors.
   */
  analyzeApplication(
    jobDescription: string,
    profile: Profile,
    questions: QuestionForModel[],
    signal?: AbortSignal,
  ): Promise<AnalyzeApplicationResult>;
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
  /**
   * Parses an uploaded resume PDF into a draft extraction for the candidate to review — never
   * saved on its own; the options page's existing `saveProfile` above is still the only save path.
   */
  extractResume(file: File, signal?: AbortSignal): Promise<ExtractedProfile>;
  /**
   * `idempotencyKey` should be the same string across every retry of one logical save attempt — a
   * re-fill's create is retried under the run's own id (`background/applicationPipeline.ts`), and
   * the Log tab generates one per extraction (`panel/LogApplication.tsx`) — so a resend after a
   * timeout lands the same row back instead of writing a second one. See
   * `applicationStore.ts`'s `create`.
   */
  saveApplication(
    payload: NewApplicationRequest,
    idempotencyKey: string,
  ): Promise<ApplicationWriteResult>;
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

/**
 * The plain HTTP adapter, before session recovery — see {@link withSessionRecovery}. Each method
 * calls `callBackend.ts`'s `transport` directly, stating `method` explicitly even where it agrees
 * with the transport's own bodyless-request default (`GET`) — see that module's own doc comment for
 * why a divergence-prone default has no place at this seam.
 */
const rawHttpBackendClient: BackendClient = {
  extractJob: (jobDescription, signal) =>
    transport.json('/extract-job', JobInfoSchema, {
      method: 'POST',
      body: ExtractJobRequestSchema.parse({ jobDescription }),
      signal,
    }),

  tailorResume: (profile, jobInfo, signal) =>
    transport.json('/tailor-resume', TailoredResumeSchema, {
      method: 'POST',
      body: TailorResumeRequestSchema.parse({ profile, jobInfo }),
      signal,
    }),

  answerQuestions: (profile, jobInfo, questions, signal) =>
    transport.json('/answer-questions', QuestionAnswerSchema.array(), {
      method: 'POST',
      body: AnswerQuestionsRequestSchema.parse({ profile, jobInfo, questions }),
      signal,
    }),

  analyzeApplication: (jobDescription, profile, questions, signal) =>
    transport.json('/analyze', AnalyzeApplicationResponseSchema, {
      method: 'POST',
      body: AnalyzeApplicationRequestSchema.parse({ jobDescription, profile, questions }),
      signal,
      // The one route that outlives the transport's default. `llm/analyzeApplication.ts` chains
      // what used to be two separate requests — extract, then tailor/draft — inside this one, so
      // the budget has to clear that sequential worst case rather than a single leg's. 150s gives
      // real headroom above the ~34s a doubling of the measured cold figure suggests, while keeping
      // the "a hung call becomes a visible, retryable error" property the deadline exists for.
      // Revisit once `/analyze` has its own measured worst case, the way `/extract-job` did.
      timeoutMs: 150_000,
    }),

  answerChat: ({ profile, question, jobInfo, currentAnswer, messages }) =>
    transport.json('/answer-chat', AnswerChatResponseSchema, {
      method: 'POST',
      body: AnswerChatRequestSchema.parse({
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
      body: RenderResumePdfRequestSchema.parse({ profile, tailoredResume }),
      signal,
    }),

  getProfile: () => transport.json('/profile', MaybeProfileSchema, { method: 'GET' }),

  saveProfile: (profile) =>
    transport.json('/profile', ProfileSchema, {
      method: 'POST',
      body: profile satisfies SaveProfileRequest,
    }),

  extractResume: (file, signal) => {
    const formData = new FormData();
    formData.set('resume', file);
    return transport.upload('/profile/extract-resume', ExtractResumeResponseSchema, formData, {
      signal,
    });
  },

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

  findApplicationDuplicates: (jobUrl, signal) =>
    transport.json(
      `/applications?jobUrl=${encodeURIComponent(jobUrl)}&response=compact`,
      DuplicateApplicationSummarySchema,
      { method: 'GET', signal },
    ),

  signIn: authSignIn,
  signOut: authSignOut,
};

/**
 * Wraps every method but `signIn`/`signOut` in `retry` — `lib/authClient.ts`'s
 * `withSharedSessionRetry` by default, the "adopt a shared dashboard session and retry once on a
 * 401" policy `callBackend.ts`'s own doc comment names as living here.
 *
 * This is the whole `BackendClient` interface, not `callBackend.ts`'s transport underneath it,
 * because that transport is real-HTTP-only: the fake `BackendClient` the panel and options tests
 * render against never reaches it, so a retry wired in there would be invisible to every test and
 * to any future non-HTTP adapter. Wrapping the interface reaches every caller — the panel, the
 * options page and the background service worker alike — through the one seam all three already
 * share.
 *
 * `signIn`/`signOut` are excluded because they are what establishes and ends a session in the
 * first place. Retrying `signIn` after adopting a *different* session would substitute session
 * adoption for the credentials the candidate actually typed; retrying `signOut` after a 401 would
 * paper over what is often a session that is already gone, the exact state `signOut` exists to
 * leave the extension in regardless.
 *
 * `retry` is a parameter, not a hardcoded call to `withSharedSessionRetry`, so a test can exercise
 * this wrapper's shape — which methods it covers, which it doesn't — without going through the real
 * `chrome.cookies` lookup `adoptSharedSession` makes.
 *
 * Each wrapped method forwards `...args` rather than naming its parameters, so a caller that omits
 * a trailing optional one (most call `renderResumePdf` and friends with no `signal`) reaches the
 * wrapped client with exactly the arguments it sent — not that count topped up with an explicit
 * `undefined`, which is a different call as far as a test's spy assertion is concerned.
 */
/** Every `BackendClient` method {@link withSessionRecovery} wraps: all of them but the two it can't. */
type RecoveredMethod = Exclude<keyof BackendClient, 'signIn' | 'signOut'>;

/**
 * The wrapped set, named once.
 *
 * Spelled out rather than derived from the object at runtime, because `keyof` exists only in the
 * type system — but spelled out *checked*: `satisfies` rejects a name that isn't a method, and
 * `AllRecoveredMethodsListed` below rejects a method that isn't named. Without the second half a
 * newly added method would ship unwrapped and silently — `withSessionRecovery` spreads the client,
 * so the method is still present and callable, just without session recovery, which is neither a
 * type error nor a test failure, only a route that 401s where it should have adopted the dashboard
 * session. `analyzeApplication` had to be remembered in two places when it was added; now it has to
 * be remembered in one, and the compiler remembers for you.
 */
const RECOVERED_METHODS = [
  'extractJob',
  'tailorResume',
  'answerQuestions',
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
 * `never` exactly when every {@link RecoveredMethod} appears in {@link RECOVERED_METHODS}. Assigning
 * it below turns an omission into a compile error naming the method left out.
 */
type AllRecoveredMethodsListed = Exclude<RecoveredMethod, (typeof RECOVERED_METHODS)[number]>;
const _allRecoveredMethodsListed: AllRecoveredMethodsListed[] = [];
void _allRecoveredMethodsListed;

export function withSessionRecovery(
  client: BackendClient,
  retry: <T>(attempt: () => Promise<T>) => Promise<T> = withSharedSessionRetry,
): BackendClient {
  /**
   * Wraps one method by name, forwarding whatever arguments the caller actually passed.
   *
   * `client[method]` is read at call time, not captured when the wrapper is built, so a test that
   * reassigns a method on the client it already handed to this function — the override
   * `createFakeBackendClient.analyzeApplication` documents, `deps.backend.tailorResume = vi.fn(…)`
   * — reaches the wrapped client too. Capturing it eagerly would leave the composed
   * `analyzeApplication` (which reads its pieces at call time) and the wrapped method calling two
   * different fakes for the same override.
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
    // Composes `merged.extractJob`/`tailorResume`/`answerQuestions` — not `fake`'s own — so a test
    // that overrides one of those three (`panelTestHarness.ts`'s `analysisFailures`, most often)
    // still shapes this call, exactly as overriding `httpBackendClient`'s underlying routes would
    // shape the real `/analyze`. `merged` isn't assigned until after this object literal finishes,
    // but nothing here reads it before this method is actually invoked, by which point it is.
    analyzeApplication: (jobDescription, profile, questions, signal) =>
      merged.extractJob(jobDescription, signal).then(async (jobInfo) => {
        const [tailoredResume, answers] = await Promise.all([
          merged.tailorResume(profile, jobInfo, signal),
          merged.answerQuestions(profile, jobInfo, questions, signal),
        ]);
        return { jobInfo, tailoredResume, answers };
      }),
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

  const merged: BackendClient = { ...fake, ...overrides };
  return merged;
}
