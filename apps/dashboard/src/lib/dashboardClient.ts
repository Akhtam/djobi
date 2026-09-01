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
  type AddApplicationNoteRequest,
  AddApplicationNoteResultSchema,
  type AddApplicationNoteResult,
  type Application,
  ApplicationSchema,
  type ApplicationStage,
  type NewNote,
  type Note,
  type Profile,
  ProfileSchema,
  type SignInRequest,
  SignInResultSchema,
  SignOutResultSchema,
  type UpdateApplicationStageRequest,
  UpdateApplicationStageResultSchema,
  type UpdateApplicationStageResult,
} from '@djobi/shared';

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
  /** Resolves with the authoritative Stage after an optimistic write. */
  updateStage(id: string, stage: ApplicationStage): Promise<UpdateApplicationStageResult>;
  /** Appends to the notes log. `id`/`createdAt` are assigned by the server, never sent. */
  addNote(id: string, note: NewNote): Promise<AddApplicationNoteResult>;
  /**
   * The single stored Profile, or `null` before the candidate has saved one.
   *
   * The first thing the dashboard needs beyond Applications — fetched only by the Analytics view's
   * coverage report, so the list and detail views must not start paying for it.
   */
  getProfile(): Promise<Profile | null>;
  /**
   * Establishes a session — the httpOnly cookie Better Auth's response sets — or rejects with an
   * `HttpError` (401 on bad credentials). Resolves to nothing: the caller doesn't need the user
   * record back, only whether it can now make authenticated requests.
   */
  signIn(email: string, password: string): Promise<void>;
  /** Ends the session. */
  signOut(): Promise<void>;
}

/**
 * The backend's origin.
 *
 * Absolute while the dashboard runs on its own dev server. Under ADR-0001 the deployed dashboard is
 * served from the same Worker as the API, where this becomes a relative `'/api'` — which is why the
 * transport takes it as configuration rather than owning one constant for both apps. The extension
 * cannot do the same: it has no origin of its own, and its absolute URL must also match its
 * `host_permissions` entry.
 */
const BACKEND_ORIGIN = 'http://127.0.0.1:5391';

/**
 * The protocol — deadline, status-before-parse, error-body extraction, schema validation — comes
 * from `@djobi/http-client`, because the extension talks to this same backend and had all of it a
 * second time. The two had already drifted: this module's deadline covered its body reads and the
 * extension's did not, and the actionable "is it running?" message lived here rather than in the app
 * more likely to hit it. Both are now one implementation and both apps get the better half.
 *
 * `credentials: 'include'` is what carries the dashboard's session — an httpOnly cookie Better Auth
 * sets, per `docs/multi-tenant-auth.md`'s "cookie for the dashboard, bearer for the extension" split
 * — on every cross-origin call to `BACKEND_ORIGIN`. It has to sit here, on the shared transport,
 * rather than per-call: there is no request this app makes that should go out unauthenticated, sign-in
 * and sign-out included — the cookie a sign-in response sets has to be sent right back on the very
 * next call for a session to exist at all. `app.ts`'s matching `credentials: true` in its CORS
 * config is what makes the browser honor this rather than silently withhold the cookie.
 */
const transport = createHttpTransport({
  baseUrl: BACKEND_ORIGIN,
  unreachableMessage: `Couldn't reach the djobi backend at ${BACKEND_ORIGIN}. Is it running? (pnpm dev:backend)`,
  credentials: 'include',
});

/**
 * The production adapter: the same local Hono server the extension talks to.
 *
 * Full list rows are parsed through `ApplicationSchema` rather than cast. Write paths explicitly
 * request compact acknowledgements and parse their operation-specific schemas, avoiding a second
 * full-row database read after each write.
 *
 * Write bodies are built against the shared wire schemas via `satisfies`, the same way
 * `apps/extension/src/lib/backendClient.ts` does it: a drift between what this sends and what the
 * route accepts becomes a compile error rather than a field zod silently strips in transit.
 */
export const httpDashboardClient: DashboardClient = {
  listApplications: () => transport.json('/applications', ApplicationSchema.array()),

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

  getProfile: () => transport.json('/profile', MaybeProfileSchema),

  signIn: async (email, password) => {
    await transport.json('/api/auth/sign-in/email', SignInResultSchema, {
      method: 'POST',
      body: { email, password } satisfies SignInRequest,
    });
  },

  signOut: async () => {
    await transport.json('/api/auth/sign-out', SignOutResultSchema, { method: 'POST' });
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
): DashboardClient {
  const { signedIn = true, email = FIXTURE_EMAIL, password = FIXTURE_PASSWORD } = auth;
  let applications: Application[] = structuredClone(seed);
  // Every other piece of state here (`applications`, `profile`) is scoped to one fixture instance,
  // matching one browser holding one cookie — the same reason it is a closure variable rather than
  // module-level: two tests must not be able to see each other's session any more than two browsers
  // sharing a fixture would share each other's applications.
  let hasSession = signedIn;

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

    getProfile: () => {
      if (!hasSession) return unauthorized('/profile');
      return Promise.resolve(profile ? structuredClone(profile) : null);
    },

    signIn: (attemptedEmail, attemptedPassword) => {
      if (attemptedEmail === email && attemptedPassword === password) {
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

    signOut: () => {
      hasSession = false;
      return Promise.resolve();
    },
  };
}
