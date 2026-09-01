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
import { createHttpTransport } from '@djobi/http-client';
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
 */
const transport = createHttpTransport({
  baseUrl: BACKEND_ORIGIN,
  unreachableMessage: `Couldn't reach the djobi backend at ${BACKEND_ORIGIN}. Is it running? (pnpm dev:backend)`,
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
};

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
): DashboardClient {
  let applications: Application[] = structuredClone(seed);

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
    listApplications: () => Promise.resolve(structuredClone(applications)),

    updateStage: (id, stage) => {
      replace({ ...mustFind(id), stage });
      return Promise.resolve({ id, stage });
    },

    addNote: (id, note) => {
      const application = mustFind(id);
      const appended: Note = {
        ...note,
        id: `note-${Math.random().toString(36).slice(2, 10)}`,
        createdAt: new Date().toISOString(),
      };
      replace({ ...application, notes: [...application.notes, appended] });
      return Promise.resolve({ id, note: structuredClone(appended) });
    },

    getProfile: () => Promise.resolve(profile ? structuredClone(profile) : null),
  };
}
