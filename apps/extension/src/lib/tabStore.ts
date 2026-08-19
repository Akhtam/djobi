import { parseDetectedFields } from '@djobi/shared';
import type { DetectedField, JobInfo, QuestionAnswer, TailoredResume } from '@djobi/shared';
import type { JobPageData } from './messages';
import {
  isSameJobUrl,
  jobKeyForUrl,
  type JobContext,
  type JobDescriptionSource,
} from './jobContext';

/**
 * Everything known about one browser tab's job application, under one serialized storage key.
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
 * browser closes (in-progress review state isn't the permanent record — that is the `applications`
 * row written after an explicit save), and is directly readable from both the background
 * worker and the panel, so neither needs a message round-trip to reach it.
 * Frames have page lifetime; Job Context and run have job lifetime and survive recognized same-job
 * routes. The tab closing still removes the whole key.
 */

export type PipelineStatus =
  | 'analyzing'
  | 'analyze-error'
  | 'duplicate'
  | 'review'
  | 'filling'
  | 'fill-error'
  | 'filled'
  | 'saving'
  | 'save-error'
  | 'saved';
// Deliberately excludes 'loading'/'no-profile'/'ready' — those are panel-local bootstrap state
// (has a profile loaded yet, has an active tab been found yet), not Application Pipeline progress.
// A null `run` means "ready".

/** The Fill Step's authoritative reading of what the page confirmed. */
export type FillOutcome =
  'unverified' | 'no-fields-detected' | 'nothing-filled' | 'complete' | 'incomplete';

/**
 * Why an Analysis or Fill Step failed. Without this the run's `status` could say *that* something
 * failed but never *why*, so the runner had nowhere to put the cause it had caught and the panel
 * could only ever render a generic message.
 */
export interface PipelineFailure {
  /** Which pipeline operation failed. */
  step: 'analysis' | 'fill' | 'save';
  /** The underlying cause, verbatim — e.g. `POST /answer-questions failed (500): …`. */
  message: string;
}

/**
 * What the candidate already has on file for this job URL, when the duplicate guard stopped a run.
 *
 * A flattened summary rather than the whole `Application`: the panel needs four fields to explain
 * itself, and storing the full record would put a tailored resume and every answer into
 * `chrome.storage.session` for a run that deliberately did no work.
 */
export interface DuplicateApplication {
  id: string;
  company: string;
  roleTitle: string;
  /** The *most recent* save for this URL — the lookup returns matches newest-first. */
  createdAt: string;
  /** How many saved applications share this URL. Greater than one means repeated applications. */
  count: number;
}

export interface PipelineRunState {
  /** Identifies this attempt so async work cannot update a newer run for the same tab. */
  runId: string;
  status: PipelineStatus;
  tabUrl: string | null;
  jobPageData: JobPageData;
  /**
   * The candidate-reviewed job description, as analyzed. Kept on the run so the panel can show
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
  /** Set by the Fill Step from the page's response; `null` before it completes. */
  fillOutcome: FillOutcome | null;
  /**
   * How many fields the Fill Step wrote when a frame confirmed the result, resume included. For an
   * `unverified` outcome this is the optimistic attempted count. Zero can mean no fields were
   * detected, which `unresolvedRequiredFields` alone cannot distinguish from success.
   */
  filledFieldCount: number;
  /** The permanent record created by the first explicit save, if any. */
  applicationId: string | null;
  /** Set alongside a `duplicate` status; `null` on every run that was allowed to proceed. */
  duplicateOf: DuplicateApplication | null;
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
  /** Editable posting text retained across same-job routes, even before Analysis starts. */
  jobContext: JobContext | null;
  run: PipelineRunState | null;
}

type StoredPipelineRun = Omit<PipelineRunState, 'fillOutcome' | 'runId'> & {
  /** Absent on runs written before asynchronous updates were scoped to one run. */
  runId?: string;
  /** Absent on runs written before FillOutcome was persisted. */
  fillOutcome?: FillOutcome | null;
};

type StoredTabState = Omit<TabState, 'jobContext' | 'run'> & {
  /** Absent in entries written before retained Job Description drafts existed. */
  jobContext?: JobContext | null;
  run: StoredPipelineRun | null;
};

const EMPTY: TabState = { frames: {}, jobContext: null, run: null };

/** Exported so `chrome.storage.onChanged` subscribers can pick their tab's key out of a change set. */
export function storageKey(tabId: number): string {
  return `tab:${tabId}`;
}

/**
 * Reads a tab's entry, re-parsing every Detected Field it carries.
 *
 * This is a version-skew boundary, not merely a deserialization one. `chrome.storage.session`
 * outlives an extension reload: the entry a tab holds was written by whichever build was running
 * when that tab was opened, which need not be the build reading it back. Casting the JSON to
 * `TabState` — as this did — meant a field written before `elementRole` or `options[].selector`
 * existed arrived looking valid and failed much later, as a field the Fill Step couldn't fill, with
 * nothing pointing back here.
 *
 * Only the fields are re-parsed. The rest of the run is extension-internal state whose shape moves
 * with the code that reads it, and a stricter parse there would throw away a live run over a field
 * nobody was about to use. New state members still need conservative defaults here: an older build
 * did not persist whether the page answered its fill request, so a completed legacy run is
 * `unverified` rather than reconstructing certainty from its counts.
 */
async function read(tabId: number): Promise<TabState> {
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get<Record<string, StoredTabState>>(key);
  const state = stored[key];
  if (!state) return EMPTY;

  return {
    ...state,
    jobContext: state.jobContext ?? null,
    frames: Object.fromEntries(
      Object.entries(state.frames ?? {}).map(([frameId, frame]) => [
        frameId,
        { ...frame, data: { fields: parseDetectedFields(frame.data?.fields) } },
      ]),
    ),
    run: state.run
      ? {
          ...state.run,
          // Session storage survives extension reloads. Give a legacy run a deterministic identity
          // so captured operations remain comparable for the rest of that tab's lifetime.
          runId: state.run.runId ?? `legacy:${tabId}`,
          jobPageData: { fields: parseDetectedFields(state.run.jobPageData?.fields) },
          unresolvedRequiredFields: parseDetectedFields(state.run.unresolvedRequiredFields),
          fillOutcome:
            state.run.fillOutcome !== undefined
              ? state.run.fillOutcome
              : ['filled', 'saving', 'save-error', 'saved'].includes(state.run.status)
                ? 'unverified'
                : null,
        }
      : null,
  };
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
 * The queue is in-memory and therefore orders one JavaScript context. All mutations are routed
 * through the service worker so detection, run progress, edits, and invalidation share this queue.
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

/** A detected frame together with the id needed to address it. */
export interface DetectedFrameRef {
  frameId: number;
  data: JobPageData;
}

/**
 * The frame holding the tab's job application form, *and its id* — the frame that detected the most
 * fields. A host page wrapping an ATS iframe often has a stray file input of its own, and picking by
 * field count stops that from shadowing the iframe's real form.
 *
 * The id is the part that matters to the Fill Step. `chrome.tabs.sendMessage` with no `frameId`
 * delivers to *every* frame and resolves with whichever answers first, and the content script runs
 * in all of them — so a third-party iframe (an invisible hCaptcha, a tag-manager pixel) answers
 * `FILL_FORM` with an empty result before the real frame has finished verifying its own writes, and
 * the pipeline reads "nothing landed" no matter what actually happened. Addressing the frame is the
 * fix; `content/index.ts` staying silent in frames that hold none of the fields is the backstop.
 */
export async function getDetectedFrame(tabId: number): Promise<DetectedFrameRef | null> {
  const frames = Object.entries((await read(tabId)).frames);
  if (frames.length === 0) return null;

  const [frameId, frame] = frames.reduce((best, entry) =>
    entry[1].data.fields.length > best[1].data.fields.length ? entry : best,
  );
  // Keys round-trip through JSON as strings; the id has to go back over `chrome.tabs.sendMessage`
  // as the number it started as.
  return { frameId: Number(frameId), data: frame.data };
}

/** The detected form itself, for callers that don't need to address the frame it lives in. */
export async function getDetectedPage(tabId: number): Promise<JobPageData | null> {
  return (await getDetectedFrame(tabId))?.data ?? null;
}

export async function getPipelineRun(tabId: number): Promise<PipelineRunState | null> {
  return (await read(tabId)).run;
}

/** The retained pre-analysis Job Description for this tab, if one has been supplied. */
export async function getJobContext(tabId: number): Promise<JobContext | null> {
  return (await read(tabId)).jobContext;
}

/**
 * Persists the editable pre-analysis draft through the service worker's per-tab write queue.
 * Clearing the editor removes the context instead of leaving an empty draft that can be restored.
 */
export async function setJobContext(
  tabId: number,
  sourceUrl: string,
  jobDescription: string,
  source: JobDescriptionSource,
): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const jobKey = jobKeyForUrl(sourceUrl);
    if (!jobKey) return;

    if (!jobDescription.trim()) {
      await write(tabId, { ...state, jobContext: null });
      return;
    }

    const existing = state.jobContext?.jobKey === jobKey ? state.jobContext : null;
    await write(tabId, {
      ...state,
      jobContext: {
        jobKey,
        // Keep the overview URL once captured; an `/application` edit must not replace the URL used
        // by Duplicate Guard and Save with a less useful route.
        sourceUrl: existing?.sourceUrl ?? sourceUrl,
        jobDescription,
        source: existing?.source === 'scraped' ? 'scraped' : source,
      },
    });
  });
}

export async function setPipelineRun(tabId: number, run: PipelineRunState): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    await write(tabId, { ...state, run });
  });
}

/**
 * Merges `patch` onto the tab's existing run only when its identity matches. A missing or newer run
 * is a no-op, so completions captured before navigation or re-analysis cannot mutate current state.
 */
export async function patchPipelineRun(
  tabId: number,
  expectedRunId: string,
  patch: Partial<Omit<PipelineRunState, 'runId'>>,
): Promise<boolean> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    if (!state.run || state.run.runId !== expectedRunId) return false;
    await write(tabId, { ...state, run: { ...state.run, ...patch } });
    return true;
  });
}

/**
 * Atomically claims the current run for an operation by changing its status only when it is still
 * in one of `allowedStatuses`. Returning the updated snapshot lets the caller perform work against
 * exactly the run it claimed; a concurrent command sees the new status and receives `null`.
 */
export async function transitionPipelineRun(
  tabId: number,
  allowedStatuses: readonly PipelineStatus[],
  patch: Partial<Omit<PipelineRunState, 'runId'>>,
): Promise<PipelineRunState | null> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    if (!state.run || !allowedStatuses.includes(state.run.status)) return null;
    const run = { ...state.run, ...patch };
    await write(tabId, { ...state, run });
    return run;
  });
}

export async function clearTabState(tabId: number): Promise<void> {
  return withTabLock(tabId, () => chrome.storage.session.remove(storageKey(tabId)));
}

/**
 * Drops page-specific frames on every navigation while retaining data that still belongs to the
 * same job. A different posting clears everything; closing the tab always clears everything.
 */
export async function handleTabNavigation(tabId: number, nextUrl: string): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const jobContext =
      state.jobContext && isSameJobUrl(state.jobContext.sourceUrl, nextUrl)
        ? state.jobContext
        : null;
    const run = state.run && isSameJobUrl(state.run.tabUrl, nextUrl) ? state.run : null;
    await write(tabId, { frames: {}, jobContext, run });
  });
}

/** Wires service-worker invalidation for tab closure and navigation. */
export function registerTabStateCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearTabState(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url !== undefined) void handleTabNavigation(tabId, changeInfo.url);
  });
}
