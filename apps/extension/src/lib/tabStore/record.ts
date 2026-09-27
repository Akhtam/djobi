/**
 * The one `chrome.storage.session` record per tab behind every `tabStore/` interface — the run, the
 * detected frames and the Job Context share it, with one write queue (separate locks would
 * reintroduce lost updates).
 *
 * Session storage survives worker eviction, clears when the browser closes (the permanent record is
 * the saved Application), and is readable from both the worker and the panel.
 */
import { parseDetectedFields } from '@djobi/shared';
import type { KeywordCoverage } from '@djobi/shared';
import type { JobPageData } from '../messages';
import type { JobContext } from '../jobContext';
import {
  backgroundProgressOf,
  hasFilled,
  isRunFailureKind,
  type FillOutcome,
  type PipelineRunState,
  type RunStep,
} from '../run';

/** One frame's latest detection; a tab holds one per reporting frame. */
export interface DetectedFrame {
  data: JobPageData;
  /**
   * Incremented per report, so a slow enrichment can tell it was superseded. A counter, not a
   * timestamp: two reports can share a millisecond.
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
 * Reads a tab's entry, re-parsing its Detected Fields — the entry may have been written by an older
 * extension build before a reload. The rest of the run isn't re-parsed, but new members need
 * conservative defaults here (e.g. legacy completed runs read as `unverified`).
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
          // Older builds didn't measure coverage; empty reads as "not measured".
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
 * Per-tab queue serializing read-modify-write cycles, so concurrent frame reports don't drop each
 * other. In-memory, so all mutations go through the service worker.
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

/**
 * The run fields written by the background — `lib/run/state.ts`'s split, applied to a
 * possibly-absent run.
 */
function progressOf(run: PipelineRunState | null | undefined): object | null {
  return run ? backgroundProgressOf(run) : null;
}

export interface RunRecordChange {
  previous: PipelineRunState | null;
  current: PipelineRunState | null;
  progressMoved: boolean;
  pageStateMoved: boolean;
}

/**
 * Projects a record write into run values plus flags for which owner moved it; subscribers never
 * see the stored layout. Runs aren't normalized, so comparisons see what was stored.
 */
export function subscribeRunRecord(
  tabId: number,
  onChange: (change: RunRecordChange) => void,
): () => void {
  const key = storageKey(tabId);

  function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
    const change = changes[key];
    if (areaName !== 'session' || !change) return;
    const previous = change.oldValue as TabState | undefined;
    const current = change.newValue as TabState | undefined;
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
