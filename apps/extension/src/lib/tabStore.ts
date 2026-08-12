import type { DetectedField, JobInfo, QuestionAnswer, TailoredResume } from '@djobi/shared';
import type { JobPageData } from './messages';

/**
 * Everything known about one browser tab's job application, under one key with one lifetime.
 *
 * This replaces two stores that answered the same question — "what do we know about this tab?" —
 * under different rules: an in-memory `Map` in the service worker holding the content script's
 * detection, and `chrome.storage.session` holding the Application Pipeline run. That split cost us
 * three ways. The `Map` died whenever the service worker was evicted (~30s idle), silently losing a
 * detected job page the panel would then refuse to analyze. It was never cleaned up, so every tab
 * ever visited leaked an entry. And keying it by tab alone let any frame's detection overwrite any
 * other's — which matters, because the content script runs in every frame and an ATS form is
 * usually inside an iframe on a company's own careers page.
 *
 * Backed entirely by `chrome.storage.session`: survives service-worker eviction, clears when the
 * browser closes (in-progress review state isn't the permanent record — that's the `applications`
 * row written at the end of the Fill Step), and is directly readable from both the background
 * worker and the panel, so neither needs a message round-trip to reach it.
 */

export type PipelineStatus =
  'analyzing' | 'analyze-error' | 'review' | 'filling' | 'fill-error' | 'filled';
// Deliberately excludes 'loading'/'no-profile'/'ready' — those are panel-local bootstrap state
// (has a profile loaded yet, has an active tab been found yet), not Application Pipeline progress.
// A null `run` means "ready".

/**
 * Why an Analysis or Fill Step failed. Without this the run's `status` could say *that* something
 * failed but never *why*, so the runner had nowhere to put the cause it had caught and the panel
 * could only ever render a generic message.
 */
export interface PipelineFailure {
  /** Which half of the Application Pipeline failed. */
  step: 'analysis' | 'fill';
  /** The underlying cause, verbatim — e.g. `POST /answer-questions failed (500): …`. */
  message: string;
}

export interface PipelineRunState {
  status: PipelineStatus;
  tabUrl: string | null;
  jobPageData: JobPageData;
  /**
   * The job description the candidate pasted, as analyzed. Kept on the run so the panel can show
   * it back for editing and a re-analysis, and so a reopened panel doesn't lose it.
   */
  jobDescription: string;
  jobInfo: JobInfo | null;
  tailoredResume: TailoredResume | null;
  answers: QuestionAnswer[];
  /** Set alongside an `analyze-error`/`fill-error` status; cleared on every fresh attempt. */
  failure: PipelineFailure | null;
  /** Required fields the Fill Step couldn't resolve a value for. Populated once it completes. */
  unresolvedRequiredFields: DetectedField[];
  /**
   * How many fields the Fill Step actually wrote, resume included. Zero is the signature of a run
   * that had no detected fields to work with, which `unresolvedRequiredFields` alone reports as an
   * empty list — i.e. as success.
   */
  filledFieldCount: number;
}

/**
 * A run whose Analysis Step has completed. Encoding the Fill Step's precondition as a type means a
 * caller can't forget to check it — the narrowing happens once, where the run is read.
 */
export type AnalyzedRun = PipelineRunState & {
  jobInfo: JobInfo;
  tailoredResume: TailoredResume;
};

/** Narrows a run to one the Fill Step can act on, or `null` if the Analysis Step hasn't finished. */
export function asAnalyzedRun(run: PipelineRunState | null): AnalyzedRun | null {
  return run?.jobInfo && run.tailoredResume ? (run as AnalyzedRun) : null;
}

/**
 * One frame's most recent detection. The content script runs in every frame, so a tab can hold
 * several — typically an ATS iframe with the real form alongside a host page with none.
 */
interface DetectedFrame {
  data: JobPageData;
  /**
   * Per-frame revision, incremented on every report. A slow API-oracle enrichment compares the
   * revision it was fetched for against the current one to tell whether it has been superseded.
   * Deliberately a counter and not a timestamp: two reports can land in the same millisecond, and
   * a clock-based marker would then let a stale enrichment through.
   */
  revision: number;
}

export interface TabState {
  /** Keyed by frame id (stringified — this round-trips through JSON). */
  frames: Record<string, DetectedFrame>;
  run: PipelineRunState | null;
}

const EMPTY: TabState = { frames: {}, run: null };

/** Exported so `chrome.storage.onChanged` subscribers can pick their tab's key out of a change set. */
export function storageKey(tabId: number): string {
  return `tab:${tabId}`;
}

async function read(tabId: number): Promise<TabState> {
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get<Record<string, TabState>>(key);
  return stored[key] ?? EMPTY;
}

async function write(tabId: number, state: TabState): Promise<void> {
  await chrome.storage.session.set({ [storageKey(tabId)]: state });
}

/**
 * Serializes read-modify-write cycles for a tab. Every mutation here reads the whole entry, changes
 * part of it and writes it back, and those steps interleave freely: the content script runs in each
 * frame and they report at nearly the same instant, so two concurrent reports would both read the
 * pre-write state and the second write would silently drop the first frame's detection.
 *
 * The queue is in-memory, so it only orders writes originating in the same context. Background and
 * panel writes can still interleave with each other — they touch different parts of the entry
 * (detection vs. run) so it hasn't bitten, but it is not a general-purpose lock.
 */
const writeQueues = new Map<number, Promise<unknown>>();

function withTabLock<T>(tabId: number, mutate: () => Promise<T>): Promise<T> {
  const next = (writeQueues.get(tabId) ?? Promise.resolve()).then(mutate, mutate);
  // Park a non-rejecting handle so one failed mutation can't poison the queue for the next.
  writeQueues.set(
    tabId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Records what one frame detected. Returns the new revision to hand back to
 * {@link enrichDetectedFields}, which uses it to detect that it has been superseded.
 */
export async function reportDetectedPage(
  tabId: number,
  frameId: number,
  data: JobPageData,
): Promise<number> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const revision = (state.frames[frameId]?.revision ?? 0) + 1;
    await write(tabId, {
      ...state,
      frames: { ...state.frames, [frameId]: { data, revision } },
    });
    return revision;
  });
}

/**
 * Applies API-oracle-enriched fields to a frame's detection — but only if that frame hasn't been
 * re-reported since revision `revision`. The enrichment is fired off without being awaited, so without
 * this check a result for a page the tab has already navigated away from would land on top of the
 * newer detection.
 */
export async function enrichDetectedFields(
  tabId: number,
  frameId: number,
  revision: number,
  fields: DetectedField[],
): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const frame = state.frames[frameId];
    if (!frame || frame.revision !== revision) return;

    await write(tabId, {
      ...state,
      frames: { ...state.frames, [frameId]: { ...frame, data: { ...frame.data, fields } } },
    });
  });
}

/**
 * The tab's job application page: the frame that detected the most fields, since that's the one
 * actually holding the form. A host page wrapping an ATS iframe often has a stray file input of its
 * own, and picking by field count stops that from shadowing the iframe's real form.
 */
export async function getDetectedPage(tabId: number): Promise<JobPageData | null> {
  const frames = Object.values((await read(tabId)).frames);
  if (frames.length === 0) return null;

  return frames.reduce((best, frame) =>
    frame.data.fields.length > best.data.fields.length ? frame : best,
  ).data;
}

export async function getPipelineRun(tabId: number): Promise<PipelineRunState | null> {
  return (await read(tabId)).run;
}

export async function setPipelineRun(tabId: number, run: PipelineRunState): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    await write(tabId, { ...state, run });
  });
}

/**
 * Merges `patch` onto the tab's existing run. A no-op when no run has been started — callers use
 * this for progress updates on a run `setPipelineRun` already created, not to lazily create one
 * (there's no sensible default for `jobPageData`).
 */
export async function patchPipelineRun(
  tabId: number,
  patch: Partial<PipelineRunState>,
): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    if (!state.run) return;
    await write(tabId, { ...state, run: { ...state.run, ...patch } });
  });
}

export async function clearTabState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(storageKey(tabId));
}

/** Wires cleanup so a closed tab leaves nothing behind. Call once at startup. */
export function registerTabStateCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearTabState(tabId);
  });
}
