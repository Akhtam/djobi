/**
 * The dashboard's view of its data source, and the only place in this app that names a backend
 * path.
 *
 * Two implementations sit behind one interface, exactly as `BackendClient` / `httpBackendClient` do
 * in `apps/extension/src/lib/backendClient.ts`, for the same reason: it turns the boundary into
 * something a test can substitute, so the views are exercised end to end with no network.
 *
 * `httpDashboardClient` is what the app runs on. `createFixtureDashboardClient` exists for the test
 * suite — it is not wired into `main.tsx`, deliberately: a runtime flag that swaps the real backend
 * for fake data is a flag that can be left on, and an app that looks like it is saving while
 * writing to memory is worse than one that visibly can't reach its backend.
 */
import { createHttpTransport, HttpError } from '@djobi/http-client';
import {
  DuplicateApplicationSummarySchema,
  type DuplicateApplicationSummary,
  type ExtractedProfile,
  ExtractResumeResponseSchema,
  type ExtractJobRequest,
  type JobInfo,
  JobInfoSchema,
  type AddApplicationNoteRequest,
  AddApplicationNoteResultSchema,
  type AddApplicationNoteResult,
  DeleteApplicationNoteResultSchema,
  type DeleteApplicationNoteResult,
  type Application,
  ApplicationSchema,
  type ApplicationStage,
  type NewNote,
  NewApplicationSchema,
  type NewApplicationRequest,
  type Note,
  type Profile,
  ProfileSchema,
  type SaveProfileRequest,
  type SignInRequest,
  SignInResultSchema,
  SignOutResultSchema,
  type SignUpRequest,
  SignUpResultSchema,
  type UpdateApplicationStageRequest,
  UpdateApplicationStageResultSchema,
  type UpdateApplicationStageResult,
} from '@djobi/shared';
import { fixtureExtractedProfile } from './fixtures.js';

/**
 * What `GET /profile` answers with. Nullable rather than optional: `null` is the real answer for a
 * candidate who hasn't set a Profile up yet, not a missing response — the same schema
 * `apps/extension/src/lib/backendClient.ts` builds for the same route.
 */
const MaybeProfileSchema = ProfileSchema.nullable();

/**
 * Everything the dashboard needs from the outside world.
 *
 * There is deliberately no `getApplication(id)`. Both views read from one loaded array held by
 * `useApplicationStore`, so a single-record fetch would only introduce a second copy of a record
 * that can disagree with the list. See that module for why.
 */
export interface DashboardClient {
  listApplications(): Promise<Application[]>;
  /** Extracts the reviewable job details used by a manual dashboard entry. */
  extractJob(jobDescription: string): Promise<JobInfo>;
  /**
   * Creates a manual application and returns the full authoritative row.
   *
   * `idempotencyKey` should be the same string across every retry of one logical save attempt —
   * `NewApplication.tsx` generates it once per extraction and reuses it for every submit while that
   * review is on screen — so a resend after a timeout lands the same row back instead of a second
   * one. See `applicationStore.ts`'s `create`.
   */
  createApplication(payload: NewApplicationRequest, idempotencyKey: string): Promise<Application>;
  /** Existing rows saved against the exact posting URL, for the manual-entry warning. */
  findApplicationDuplicates(jobUrl: string): Promise<DuplicateApplicationSummary>;
  /** Resolves with the authoritative Stage after an optimistic write. */
  updateStage(id: string, stage: ApplicationStage): Promise<UpdateApplicationStageResult>;
  /** Appends to the notes log. `id`/`createdAt` are assigned by the server, never sent. */
  addNote(id: string, note: NewNote): Promise<AddApplicationNoteResult>;
  /**
   * Removes one note from the log. Rejects when the note is not there — the route answers 404 for
   * a note it cannot find, and an optimistic caller has to be able to tell that apart from a
   * delete that worked.
   */
  deleteNote(id: string, noteId: string): Promise<DeleteApplicationNoteResult>;
  /**
   * The single stored Profile, or `null` before the candidate has saved one.
   *
   * The first thing the dashboard needs beyond Applications — fetched only by the Analytics view's
   * coverage report, so the list and detail views must not start paying for it.
   */
  getProfile(): Promise<Profile | null>;
  /** Persists the full Profile and returns the authoritative saved row. */
  saveProfile(profile: Profile): Promise<Profile>;
  /**
   * Parses an uploaded resume PDF into a draft extraction for the candidate to review — never
   * saved on its own; `saveProfile` above is still the only write path.
   */
  extractResume(file: File): Promise<ExtractedProfile>;
  /**
   * Establishes a session — the httpOnly cookie Better Auth's response sets — or rejects with an
   * `HttpError` (401 on bad credentials). Resolves to nothing: the caller doesn't need the user
   * record back, only whether it can now make authenticated requests.
   */
  signIn(email: string, password: string): Promise<void>;
  /**
   * Creates a new account and establishes a session for it in the same call — Better Auth's
   * `/sign-up/email` sets the same session cookie `/sign-in/email` does, so a fresh sign-up lands
   * the candidate straight in the dashboard rather than requiring a second sign-in.
   */
  signUp(email: string, password: string, name: string): Promise<void>;
  /** Ends the session. */
  signOut(): Promise<void>;
}

/**
 * The backend's real origin — used only to name it in {@link transport}'s `unreachableMessage`, not
 * as the transport's `baseUrl`. See that constant for why the two are no longer the same value.
 */
const BACKEND_ORIGIN = import.meta.env.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:5391';

/**
 * The protocol — deadline, status-before-parse, error-body extraction, schema validation — comes
 * from `@djobi/http-client`, because the extension talks to this same backend and had all of it a
 * second time. The two had already drifted: this module's deadline covered its body reads and the
 * extension's did not, and the actionable "is it running?" message lived here rather than in the app
 * more likely to hit it. Both are now one implementation and both apps get the better half.
 *
 * `baseUrl` is relative (`''`), not `BACKEND_ORIGIN`, so every call this app makes is same-origin
 * from the browser's point of view. It was `BACKEND_ORIGIN` originally, and that broke real login:
 * the dashboard (`:5174`) and the backend (`:5391`) are different origins, which makes the session
 * cookie a *third-party* cookie — Chrome partitions/blocks those by default no matter what
 * `SameSite`/`Secure` say. Sign-in still appeared to succeed (`Set-Cookie` on the response is never
 * blocked), but the very next authenticated call came back 401 because the cookie was never sent
 * back. `vite.config.ts`'s dev-server `proxy` is the other half of this fix — it forwards these
 * relative paths to the real backend server-side, invisibly to the browser, which is also exactly
 * what production looks like once `docs/multi-tenant-auth.md`'s ADR-0001 (dashboard served from the
 * same Worker as the API) ships: this was always the eventual shape, not a dev-only workaround.
 *
 * `credentials: 'include'` is kept anyway: harmless once same-origin (`fetch`'s own default,
 * `'same-origin'`, would behave identically here), and it's what carries the session correctly for
 * anyone running this against a genuinely cross-origin backend without the proxy in front of it.
 */
const transport = createHttpTransport({
  baseUrl: '',
  unreachableMessage: `Couldn't reach the djobi backend at ${BACKEND_ORIGIN}. Is it running? (pnpm dev:backend)`,
  credentials: 'include',
});

/**
 * The production adapter: the same local Hono server the extension talks to.
 *
 * Full rows are parsed through `ApplicationSchema` rather than cast. Tracking writes request compact
 * acknowledgements; manual creation deliberately asks for the full row so the shared dashboard store
 * can insert it without another list request.
 *
 * Write bodies are built against the shared wire schemas via `satisfies`, the same way
 * `apps/extension/src/lib/backendClient.ts` does it: a drift between what this sends and what the
 * route accepts becomes a compile error rather than a field zod silently strips in transit.
 */
export const httpDashboardClient: DashboardClient = {
  listApplications: () => transport.json('/applications', ApplicationSchema.array()),

  extractJob: (jobDescription) =>
    transport.json('/extract-job', JobInfoSchema, {
      method: 'POST',
      body: { jobDescription } satisfies ExtractJobRequest,
    }),

  createApplication: (payload, idempotencyKey) =>
    transport.json('/applications', ApplicationSchema, {
      method: 'POST',
      body: payload,
      idempotencyKey,
    }),

  findApplicationDuplicates: (jobUrl) =>
    transport.json(
      `/applications?jobUrl=${encodeURIComponent(jobUrl)}&response=compact`,
      DuplicateApplicationSummarySchema,
    ),

  updateStage: (id, stage) =>
    transport.json(
      `/applications/${encodeURIComponent(id)}/stage?response=compact`,
      UpdateApplicationStageResultSchema,
      { method: 'PATCH', body: { stage } satisfies UpdateApplicationStageRequest },
    ),

  addNote: (id, note) =>
    transport.json(
      `/applications/${encodeURIComponent(id)}/notes?response=compact`,
      AddApplicationNoteResultSchema,
      { method: 'POST', body: note satisfies AddApplicationNoteRequest },
    ),

  deleteNote: (id, noteId) =>
    transport.json(
      `/applications/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}?response=compact`,
      DeleteApplicationNoteResultSchema,
      { method: 'DELETE' },
    ),

  getProfile: () => transport.json('/profile', MaybeProfileSchema),

  saveProfile: (profile) =>
    transport.json('/profile', ProfileSchema, {
      method: 'POST',
      body: profile satisfies SaveProfileRequest,
    }),

  extractResume: (file) => {
    const formData = new FormData();
    formData.set('resume', file);
    return transport.upload('/profile/extract-resume', ExtractResumeResponseSchema, formData);
  },

  signIn: async (email, password) => {
    await transport.json('/api/auth/sign-in/email', SignInResultSchema, {
      method: 'POST',
      body: { email, password } satisfies SignInRequest,
    });
  },

  signUp: async (email, password, name) => {
    await transport.json('/api/auth/sign-up/email', SignUpResultSchema, {
      method: 'POST',
      body: { email, password, name } satisfies SignUpRequest,
    });
  },

  signOut: async () => {
    await transport.json('/api/auth/sign-out', SignOutResultSchema, {
      method: 'POST',
      body: {},
    });
  },
};

/** What `signIn` accepts against a fixture client that was never given its own. */
const FIXTURE_EMAIL = 'jane@example.com';
const FIXTURE_PASSWORD = 'correct horse battery staple';

/**
 * How a fixture client's session starts, and what credentials `signIn` accepts against it.
 *
 * `signedIn` defaults to `true` — most of this suite drives the app past login, the same reason
 * `profile` defaults to `null` below rather than the reverse: the common case costs a caller
 * nothing, and a test of the login flow itself is the one that opts out.
 */
export interface FixtureAuthOptions {
  signedIn?: boolean;
  email?: string;
  password?: string;
}

/**
 * What `extractResume` resolves or rejects with — a config bag for the same reason
 * {@link FixtureAuthOptions} is one: a case that cares picks one field, everything else keeps a
 * sensible default. `error` takes priority when both are given, since a case testing the failure
 * path has no use for a draft that's never returned.
 */
export interface FixtureResumeUploadOptions {
  /** Defaults to `fixtureExtractedProfile` — a populated sample draft. */
  extraction?: ExtractedProfile;
  /** When set, `extractResume` rejects with this message instead of resolving. */
  error?: string;
}

/**
 * The fixture adapter: the whole interface over an in-memory copy of `fixtures.ts`.
 *
 * Writes mutate that copy, so a stage change or an added note survives navigating away and back
 * within a session — which is what makes the UI genuinely exercisable with no backend at all.
 * Each call returns a *fresh* copy so a caller holding a previous result can't observe a mutation
 * it didn't ask for, matching how a real HTTP response behaves.
 *
 * `id` and `createdAt` on an appended note are generated here rather than accepted from the caller,
 * mimicking the rule `NoteSchema` states and `POST /applications/:id/notes` enforces: a note whose timestamp
 * the sender chose isn't trustworthy history.
 *
 * `profile` defaults to `null` — no Profile saved — rather than to a populated one, since that is
 * the state most existing fixture callers neither know nor care about; a case that does pass it
 * explicitly.
 */
export function createFixtureDashboardClient(
  seed: Application[],
  profile: Profile | null = null,
  auth: FixtureAuthOptions = {},
  resumeUpload: FixtureResumeUploadOptions = {},
): DashboardClient {
  const { signedIn = true, email = FIXTURE_EMAIL, password = FIXTURE_PASSWORD } = auth;
  const { extraction = fixtureExtractedProfile, error: extractionError } = resumeUpload;
  let applications: Application[] = structuredClone(seed);
  let currentProfile: Profile | null = profile;
  // Every other piece of state here (`applications`, `profile`) is scoped to one fixture instance,
  // matching one browser holding one cookie — the same reason it is a closure variable rather than
  // module-level: two tests must not be able to see each other's session any more than two browsers
  // sharing a fixture would share each other's applications.
  let hasSession = signedIn;
  // The one account this fixture will accept a sign-up for, so a test can drive the whole sign-up
  // flow without a second `FixtureAuthOptions` shape — signing up simply reassigns `email`/`password`
  // to whatever the form submitted, exactly as a real account creation would.
  let currentEmail = email;
  let currentPassword = password;
  // Mirrors `applicationStore.ts`'s in-memory adapter: a same-keyed `createApplication` retry
  // returns the row the first call already wrote rather than appending a second one.
  const applicationsByIdempotencyKey = new Map<string, Application>();

  /**
   * `requireAuth()`'s own answer, reproduced here: `app.ts` puts every route this client calls
   * behind that middleware, so a fixture that never rejects would let a test drive the signed-out
   * UI as if `deps.requireAuth` did not exist. `HttpError`'s `kind`/`status` are what
   * `useApplicationStore`'s `isUnauthorized` actually switches on, so this has to be the same shape
   * a real 401 arrives in, not merely an `Error` with a similar message.
   *
   * Returns a rejected `Promise` rather than throwing: every real `DashboardClient` method fails by
   * rejecting, and a caller like `useApplicationStore`'s load effect only attaches `.catch` to the
   * `Promise` a method returns. A synchronous throw here would escape that chain entirely and crash
   * the render instead of reaching it.
   */
  function unauthorized<T>(path: string): Promise<T> {
    return Promise.reject(
      new HttpError('http', path, `${path} failed (401): Authentication required`, 401),
    );
  }

  function find(id: string): Application | undefined {
    return applications.find((application) => application.id === id);
  }

  function replace(updated: Application): Application {
    applications = applications.map((a) => (a.id === updated.id ? updated : a));
    return structuredClone(updated);
  }

  function mustFind(id: string): Application {
    const found = find(id);
    if (!found) throw new Error(`No application with id ${id}`);
    return found;
  }

  return {
    listApplications: () => {
      if (!hasSession) return unauthorized('/applications');
      return Promise.resolve(structuredClone(applications));
    },

    extractJob: (jobDescription) => {
      if (!hasSession) return unauthorized('/extract-job');
      const first = applications[0]?.jobInfo;
      return Promise.resolve(
        structuredClone(
          first ?? {
            company: 'Example company',
            team: null,
            roleTitle: 'Example role',
            seniority: null,
            location: null,
            requirements: [],
            keywords: [],
          },
        ),
      );
    },

    createApplication: (payload, idempotencyKey) => {
      if (!hasSession) return unauthorized('/applications');

      const existing = applicationsByIdempotencyKey.get(idempotencyKey);
      if (existing) return Promise.resolve(structuredClone(existing));

      const parsed = NewApplicationSchema.parse(structuredClone(payload));
      const application = ApplicationSchema.parse({
        ...parsed,
        id: `application-${Math.random().toString(36).slice(2, 10)}`,
        createdAt: new Date().toISOString(),
      });
      applications = [application, ...applications];
      applicationsByIdempotencyKey.set(idempotencyKey, application);
      return Promise.resolve(structuredClone(application));
    },

    findApplicationDuplicates: (jobUrl) => {
      if (!hasSession) return unauthorized('/applications');
      const matches = applications
        .filter((application) => application.jobUrl === jobUrl)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = matches[0];
      return Promise.resolve({
        count: matches.length,
        latest: latest
          ? {
              id: latest.id,
              company: latest.company,
              roleTitle: latest.roleTitle,
              stage: latest.stage,
              createdAt: latest.createdAt,
            }
          : null,
      });
    },

    updateStage: (id, stage) => {
      if (!hasSession) return unauthorized(`/applications/${id}/stage`);
      replace({ ...mustFind(id), stage });
      return Promise.resolve({ id, stage });
    },

    addNote: (id, note) => {
      if (!hasSession) return unauthorized(`/applications/${id}/notes`);
      const application = mustFind(id);
      const appended: Note = {
        ...note,
        id: `note-${Math.random().toString(36).slice(2, 10)}`,
        createdAt: new Date().toISOString(),
      };
      replace({ ...application, notes: [...application.notes, appended] });
      return Promise.resolve({ id, note: structuredClone(appended) });
    },

    deleteNote: (id, noteId) => {
      if (!hasSession) return unauthorized(`/applications/${id}/notes/${noteId}`);
      const application = mustFind(id);
      const remaining = application.notes.filter((note) => note.id !== noteId);
      // Rejects rather than resolving quietly, because the route 404s for a note it cannot find
      // and a fixture that shrugged would let a caller's "did this land" logic pass here and fail
      // against the real backend.
      if (remaining.length === application.notes.length) {
        return Promise.reject(new Error(`No note ${noteId} on application ${id}`));
      }
      replace({ ...application, notes: remaining });
      return Promise.resolve({ id, noteId });
    },

    getProfile: () => {
      if (!hasSession) return unauthorized('/profile');
      return Promise.resolve(currentProfile ? structuredClone(currentProfile) : null);
    },

    saveProfile: (next) => {
      if (!hasSession) return unauthorized('/profile');
      currentProfile = structuredClone(next);
      return Promise.resolve(structuredClone(currentProfile));
    },

    extractResume: () => {
      if (!hasSession) return unauthorized('/profile/extract-resume');
      if (extractionError) return Promise.reject(new Error(extractionError));
      return Promise.resolve(structuredClone(extraction));
    },

    signIn: (attemptedEmail, attemptedPassword) => {
      if (attemptedEmail === currentEmail && attemptedPassword === currentPassword) {
        hasSession = true;
        return Promise.resolve();
      }
      return Promise.reject(
        new HttpError(
          'http',
          '/api/auth/sign-in/email',
          'POST /api/auth/sign-in/email failed (401): Invalid email or password',
          401,
        ),
      );
    },

    signUp: (newEmail, newPassword) => {
      currentEmail = newEmail;
      currentPassword = newPassword;
      hasSession = true;
      return Promise.resolve();
    },

    signOut: () => {
      hasSession = false;
      return Promise.resolve();
    },
  };
}
