/**
 * The one stored record behind every `tabStore/` interface: how a tab's entry is read, normalized,
 * written, and serialized against itself.
 *
 * Everything known about one browser tab's job application lives under one `chrome.storage.session`
 * key. That is what the run, the detected frames and the retained Job Context share — and the only
 * thing they share, which is why each presents its own interface over it. Splitting those
 * interfaces is not splitting the storage: separate locks would bring back exactly the whole-record
 * lost updates the single queue below exists to prevent.
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
 * row written after an explicit save), and is directly readable from both the background worker and
 * the panel, so neither needs a message round-trip to reach it.
 */
import { parseDetectedFields } from '@djobi/shared';
import type { KeywordCoverage } from '@djobi/shared';
import type { JobPageData } from '../messages';
import type { JobContext } from '../jobContext';
import {
  hasFilled,
  isRunFailureKind,
  type FillOutcome,
  type PipelineRunState,
  type RunStep,
} from '../run';

/**
 * One frame's most recent detection. The content script runs in every frame, so a tab can hold
 * several — typically an ATS iframe with the real form alongside a host page with none.
 */
export interface DetectedFrame {
  data: JobPageData;
  /**
   * Per-frame revision, incremented on every report. A slow API-oracle enrichment compares the
   * revision it was fetched for against the current one to tell whether it has been superseded.
   * Deliberately a counter and not a timestamp: two reports can land in the same millisecond, and
   * a clock-based marker would then let a stale enrichment through.
   */
  revision: number;
}

interface TabState {
  /** Keyed by frame id (stringified — this round-trips through JSON). */
  frames: Record<string, DetectedFrame>;
  /** Editable posting text retained across same-job routes, even before Analysis starts. */
  jobContext: JobContext | null;
  run: PipelineRunState | null;
}

type StoredPipelineFailure = { step: RunStep; kind?: unknown; message?: unknown };

type StoredPipelineRun = Omit<
  PipelineRunState,
  'fillOutcome' | 'runId' | 'coverage' | 'failure'
> & {
  /** Absent on runs written before asynchronous updates were scoped to one run. */
  runId?: string;
  /** Absent on runs written before FillOutcome was persisted. */
  fillOutcome?: FillOutcome | null;
  /** Absent on runs written before Keyword Coverage existed. */
  coverage?: KeywordCoverage[];
  /** Message-only failures were written before the run-domain taxonomy existed. */
  failure?: StoredPipelineFailure | null;
};

type StoredTabState = Omit<TabState, 'jobContext' | 'run'> & {
  /** Absent in entries written before retained Job Description drafts existed. */
  jobContext?: JobContext | null;
  run: StoredPipelineRun | null;
};

const EMPTY: TabState = { frames: {}, jobContext: null, run: null };

function storageKey(tabId: number): string {
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
export async function read(tabId: number): Promise<TabState> {
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
          // An older build analyzed without measuring coverage, and there is nothing to
          // reconstruct it from: the report is about the resume that build produced, not the one
          // this build would. Empty reads as "not measured", which is what happened.
          coverage: state.run.coverage ?? [],
          failure: state.run.failure
            ? {
                step: state.run.failure.step,
                kind: isRunFailureKind(state.run.failure.kind) ? state.run.failure.kind : 'unknown',
              }
            : null,
          fillOutcome:
            state.run.fillOutcome !== undefined
              ? state.run.fillOutcome
              : hasFilled(state.run.status)
                ? 'unverified'
                : null,
        }
      : null,
  };
}

export async function write(tabId: number, state: TabState): Promise<void> {
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

export function withTabLock<T>(tabId: number, mutate: () => Promise<T>): Promise<T> {
  const next = (writeQueues.get(tabId) ?? Promise.resolve()).then(mutate, mutate);
  // Park a non-rejecting handle so one failed mutation can't poison the queue for the next.
  writeQueues.set(
    tabId,
    next.catch(() => undefined),
  );
  return next;
}

/** Every tab id with a stored entry — for a sweep that has to visit all of them. */
export async function allTabIds(): Promise<number[]> {
  const stored = await chrome.storage.session.get(null);
  return Object.keys(stored).flatMap((key) => {
    const match = /^tab:(\d+)$/.exec(key);
    return match ? [Number(match[1])] : [];
  });
}

/** Removes a tab's entry entirely, under the same lock as every other mutation. */
export async function removeRecord(tabId: number): Promise<void> {
  return withTabLock(tabId, () => chrome.storage.session.remove(storageKey(tabId)));
}

/** Structural equality for values delivered by `chrome.storage.onChanged`. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => same(item, b[index]));
  }

  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const right = b as Record<string, unknown>;
  return keys.every((key) => key in right && same((a as Record<string, unknown>)[key], right[key]));
}

function pageStateOf(state: TabState | undefined): object {
  return { frames: state?.frames ?? {}, jobContext: state?.jobContext ?? null };
}

/** The run fields written by the background, excluding the panel's persisted review edits. */
function progressOf(run: PipelineRunState | null | undefined): object | null {
  if (!run) return null;
  const { answers: _answers, jobDescription: _jobDescription, ...progress } = run;
  return progress;
}

export interface RunRecordChange {
  previous: PipelineRunState | null;
  current: PipelineRunState | null;
  progressMoved: boolean;
  pageStateMoved: boolean;
}

/**
 * Projects a record write into the run seam and classifies which owner moved it.
 *
 * Here because the storage area, key format, record layout and ownership split are this module's to
 * know. Subscribers receive run projections and ownership flags, never the stored record itself.
 *
 * Run values remain un-normalized so comparisons see what was actually stored; an absent run is
 * projected as `null` rather than exposing the record's missing-value representation.
 */
export function subscribeRunRecord(
  tabId: number,
  onChange: (change: RunRecordChange) => void,
): () => void {
  const key = storageKey(tabId);

  function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
    if (areaName !== 'session' || !(key in changes)) return;
    const previous = changes[key].oldValue as TabState | undefined;
    const current = changes[key].newValue as TabState | undefined;
    onChange({
      previous: previous?.run ?? null,
      current: current?.run ?? null,
      progressMoved: !same(progressOf(previous?.run), progressOf(current?.run)),
      pageStateMoved: !same(pageStateOf(previous), pageStateOf(current)),
    });
  }

  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}

/** Subscribes to the page-scoped half without exposing the shared record it occupies. */
export function subscribePageRecord(tabId: number, onChange: () => void): () => void {
  return subscribeRunRecord(tabId, ({ pageStateMoved }) => {
    if (pageStateMoved) onChange();
  });
}
