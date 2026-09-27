/**
 * The dashboard's data-source port — the only place in this app that names a backend path.
 * `httpDashboardClient` is what the app runs on; `createFixtureDashboardClient` is for tests only,
 * never wired into `main.tsx` (a runtime fake-data flag could be left on).
 */
import {
  backendRoutes,
  createHttpTransport,
  HttpError,
  type BackendRoutes,
} from '@djobi/http-client';
import {
  type ExtractedProfile,
  type AddApplicationNoteRequest,
  AddApplicationNoteResultSchema,
  type AddApplicationNoteResult,
  DeleteApplicationNoteResultSchema,
  type DeleteApplicationNoteResult,
  DeleteApplicationResultSchema,
  type DeleteApplicationResult,
  type Application,
  ApplicationSchema,
  type ApplicationStage,
  type NewNote,
  NewApplicationSchema,
  type NewApplicationRequest,
  type Note,
  type Profile,
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
 * Everything the dashboard needs from the backend. No `getApplication(id)`: every view reads the
 * one array in `useApplicationStore`, so records can't disagree. The shared routes' contract is
 * `BackendRoutes`'s.
 */
export interface DashboardClient extends Pick<
  BackendRoutes,
  'extractJob' | 'getProfile' | 'saveProfile' | 'extractResume' | 'findApplicationDuplicates'
> {
  listApplications(): Promise<Application[]>;
  /**
   * Creates a manual Application and returns the full row. Reuse `idempotencyKey` across retries of
   * one save (`NewApplication.tsx` keeps one per extraction) so a resend returns the same row.
   */
  createApplication(payload: NewApplicationRequest, idempotencyKey: string): Promise<Application>;
  /** Resolves with the authoritative Stage after an optimistic write. */
  updateStage(id: string, stage: ApplicationStage): Promise<UpdateApplicationStageResult>;
  /** Appends to the notes log. `id`/`createdAt` are assigned by the server, never sent. */
  addNote(id: string, note: NewNote): Promise<AddApplicationNoteResult>;
  /** Removes one note. Rejects (404) if it isn't there, so optimistic callers can tell. */
  deleteNote(id: string, noteId: string): Promise<DeleteApplicationNoteResult>;
  /** Deletes an Application. Rejects (404) if there's no such row. */
  deleteApplication(id: string): Promise<DeleteApplicationResult>;
  /** Establishes a session (Better Auth's httpOnly cookie), or rejects with a 401 `HttpError`. */
  signIn(email: string, password: string): Promise<void>;
  /** Creates an account and signs it in (sign-up sets the same session cookie). */
  signUp(email: string, password: string, name: string): Promise<void>;
  /** Ends the session. */
  signOut(): Promise<void>;
}

/** The backend's real origin, used only in the unreachable message (requests are relative). */
const BACKEND_ORIGIN = import.meta.env.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:5391';

/**
 * The dashboard's `@djobi/http-client` transport. `baseUrl` is relative so every call is
 * same-origin — cross-origin, the session cookie is a third-party cookie that Chrome blocks, and
 * sign-in would appear to work while every later call 401s. In dev, `vite.config.ts`'s proxy
 * forwards these paths; in production the dashboard is served with the API (ADR-0001, or nginx in
 * Docker Compose). `credentials: 'include'` still covers a genuinely cross-origin backend.
 */
const transport = createHttpTransport({
  baseUrl: '',
  unreachableMessage: `Couldn't reach the djobi backend at ${BACKEND_ORIGIN}. Is it running? (pnpm dev:backend)`,
  credentials: 'include',
});

/** Routes the extension calls identically, from `@djobi/http-client`'s `backendRoutes`. */
const sharedRoutes = backendRoutes(transport);

/**
 * The production adapter. Rows are parsed through `ApplicationSchema`; tracking writes ask for
 * compact acknowledgements, while manual creation asks for the full row so the store can insert it
 * directly.
 */
export const httpDashboardClient: DashboardClient = {
  listApplications: () => transport.json('/applications', ApplicationSchema.array()),

  extractJob: sharedRoutes.extractJob,

  createApplication: (payload, idempotencyKey) =>
    transport.json('/applications', ApplicationSchema, {
      method: 'POST',
      body: payload,
      idempotencyKey,
    }),

  findApplicationDuplicates: sharedRoutes.findApplicationDuplicates,

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

  deleteApplication: (id) =>
    transport.json(`/applications/${encodeURIComponent(id)}`, DeleteApplicationResultSchema, {
      method: 'DELETE',
    }),

  getProfile: sharedRoutes.getProfile,
  saveProfile: sharedRoutes.saveProfile,
  extractResume: sharedRoutes.extractResume,

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
 * How a fixture client's session starts and which credentials `signIn` accepts. `signedIn`
 * defaults to `true`; login tests opt out.
 */
export interface FixtureAuthOptions {
  signedIn?: boolean;
  email?: string;
  password?: string;
}

/**
 * What `extractResume` resolves or rejects with; `error` wins if both are given.
 */
export interface FixtureResumeUploadOptions {
  /** Defaults to `fixtureExtractedProfile` — a populated sample draft. */
  extraction?: ExtractedProfile;
  /** When set, `extractResume` rejects with this message instead of resolving. */
  error?: string;
}

/**
 * The fixture adapter over an in-memory copy of `fixtures.ts`. Writes persist within the instance;
 * each read returns a fresh copy, like HTTP. Notes get server-style `id`/`createdAt`. `profile`
 * defaults to `null`.
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
  // Per instance, like one browser's cookie, so tests can't see each other's session.
  let hasSession = signedIn;
  // Signing up reassigns the accepted credentials, like creating a real account.
  let currentEmail = email;
  let currentPassword = password;
  // Mirrors `applicationStore.ts`'s in-memory adapter: a same-keyed `createApplication` retry
  // returns the row the first call already wrote rather than appending a second one.
  const applicationsByIdempotencyKey = new Map<string, Application>();

  /**
   * `requireAuth`'s 401, as an `HttpError` (what `isUnauthorized` checks). Returned as a rejected
   * promise, not thrown, so callers' `.catch` sees it.
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
      // Rejects like the real route's 404, so "did this land" logic is tested honestly.
      if (remaining.length === application.notes.length) {
        return Promise.reject(new Error(`No note ${noteId} on application ${id}`));
      }
      replace({ ...application, notes: remaining });
      return Promise.resolve({ id, noteId });
    },

    deleteApplication: (id) => {
      if (!hasSession) return unauthorized(`/applications/${id}`);
      mustFind(id);
      applications = applications.filter((application) => application.id !== id);
      return Promise.resolve({ id });
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
