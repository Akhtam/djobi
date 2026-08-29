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
import {
  type AddApplicationNoteRequest,
  AddApplicationNoteResultSchema,
  type AddApplicationNoteResult,
  type Application,
  ApplicationSchema,
  type ApplicationStage,
  BackendErrorBodySchema,
  type NewNote,
  type Note,
  type UpdateApplicationStageRequest,
  UpdateApplicationStageResultSchema,
  type UpdateApplicationStageResult,
} from '@djobi/shared';

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
}

const BACKEND_ORIGIN = 'http://127.0.0.1:5391';
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * A non-2xx response from the local djobi backend.
 *
 * A deliberately smaller cousin of the extension's `BackendError` rather than an import of it: that
 * module lives inside the extension's MV3 build and carries history specific to it. What is worth
 * sharing between the two is the error *body shape*, and that already lives in `@djobi/shared` as
 * `BackendErrorBodySchema` — so this reuses the schema and not the transport.
 */
export class DashboardBackendError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'DashboardBackendError';
  }
}

/** Best-effort human-readable reason from an error response body. */
function reasonFrom(raw: string): string {
  try {
    const body = BackendErrorBodySchema.safeParse(JSON.parse(raw) as unknown);
    if (body.success) return body.data.error;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return raw.trim().slice(0, 300) || 'empty response body';
}

/**
 * Sends a request and returns the parsed JSON body, having already turned a non-2xx into a
 * {@link DashboardBackendError}.
 *
 * The status is checked before any parsing: parsing first turns a real HTTP failure into an
 * unrelated `SyntaxError`, which is how a backend 500 reaches the UI as an uninformative parse
 * error. A stopped backend produces a `TypeError` from `fetch` itself, which is re-thrown as a
 * backend error too — "Failed to fetch" on its own tells the user nothing about what is wrong.
 */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  try {
    const res = await fetch(`${BACKEND_ORIGIN}${path}`, { ...init, signal });

    if (!res.ok) {
      const method = init?.method ?? 'GET';
      throw new DashboardBackendError(
        res.status,
        path,
        `${method} ${path} failed (${res.status}): ${reasonFrom(await res.text())}`,
      );
    }

    return await res.json();
  } catch (error) {
    if (error instanceof DashboardBackendError) throw error;
    if (timeoutSignal.aborted) {
      throw new DashboardBackendError(
        0,
        path,
        `The djobi backend did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
      );
    }
    if (error instanceof TypeError) {
      throw new DashboardBackendError(
        0,
        path,
        `Couldn't reach the djobi backend at ${BACKEND_ORIGIN}. Is it running? (pnpm dev:backend)`,
      );
    }
    throw error;
  }
}

/** A JSON-bodied write. The one place this app sets a request body. */
function send(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<unknown> {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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
  listApplications: async () => ApplicationSchema.array().parse(await request('/applications')),

  updateStage: async (id, stage) =>
    UpdateApplicationStageResultSchema.parse(
      await send(`/applications/${encodeURIComponent(id)}/stage?response=compact`, 'PATCH', {
        stage,
      } satisfies UpdateApplicationStageRequest),
    ),

  addNote: async (id, note) =>
    AddApplicationNoteResultSchema.parse(
      await send(
        `/applications/${encodeURIComponent(id)}/notes?response=compact`,
        'POST',
        note satisfies AddApplicationNoteRequest,
      ),
    ),
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
 */
export function createFixtureDashboardClient(seed: Application[]): DashboardClient {
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
  };
}
