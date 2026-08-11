import type { DetectedField, JobInfo, QuestionAnswer, TailoredResume } from '@djobi/shared';
import type { JobPageData } from './messages';

/**
 * Per-tab hand-off point for Application Pipeline progress, mirroring `background/jobPageStore.ts`'s
 * role for the pre-analysis `JobPageData` but for what happens after: the Analysis Step's output
 * and the user's in-review edits. Backed by `chrome.storage.session` rather than an in-memory
 * `Map` — it needs to survive not just the panel closing (which `jobPageStore.ts` was built for)
 * but also the background service worker being evicted after ~30s idle, since a slow Analysis/Fill
 * Step can easily outlast that. `chrome.storage.session` auto-clears when the browser closes,
 * appropriate for in-progress review state — the permanent record is the `applications` row saved
 * via `POST /applications` at the end of the Fill Step.
 *
 * Lives in `lib/`, not `background/`: `chrome.storage.session`'s default access level
 * (`TRUSTED_CONTEXTS`) means the panel can read and write it directly, no message round-trip
 * through the background service worker needed.
 */

export type PipelineStatus =
  'analyzing' | 'analyze-error' | 'review' | 'filling' | 'fill-error' | 'filled';
// Deliberately excludes 'loading'/'no-profile'/'ready' — those are panel-local bootstrap state
// (has a profile loaded yet, has an active tab been found yet), not Application Pipeline
// progress. No stored entry for a tabId means "ready" (mirrors jobPageStore's null convention).

export interface PipelineRunState {
  status: PipelineStatus;
  tabUrl: string | null;
  jobPageData: JobPageData;
  pageTextOverride: string | null;
  jobInfo: JobInfo | null;
  tailoredResume: TailoredResume | null;
  answers: QuestionAnswer[];
  /**
   * Required fields `fillAndSubmit` couldn't resolve a value for (e.g. a required question whose
   * drafted answer matched no DOM option) — computed by `fillAndSubmit` itself but otherwise
   * unused, so a fill could "succeed" (`status: 'filled'`) while silently leaving a required field
   * blank. Populated once the Fill Step completes; empty before then.
   */
  unresolvedRequiredFields: DetectedField[];
}

/** Exported so `chrome.storage.onChanged` subscribers (e.g. `panel/App.tsx`) can pick their tab's key out of a change set. */
export function storageKey(tabId: number): string {
  return `pipelineRun:${tabId}`;
}

export async function getPipelineRun(tabId: number): Promise<PipelineRunState | null> {
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get<Record<string, PipelineRunState>>(key);
  return stored[key] ?? null;
}

export async function setPipelineRun(tabId: number, state: PipelineRunState): Promise<void> {
  await chrome.storage.session.set({ [storageKey(tabId)]: state });
}

/**
 * Merges `patch` onto the tab's existing run, if any. A no-op when no run has been started for the
 * tab yet — callers use this for incremental progress updates on a run that `setPipelineRun`
 * already started, not to lazily create one (there's no sensible default for `jobPageData`).
 */
export async function patchPipelineRun(
  tabId: number,
  patch: Partial<PipelineRunState>,
): Promise<void> {
  const current = await getPipelineRun(tabId);
  if (!current) return;
  await setPipelineRun(tabId, { ...current, ...patch });
}

export async function clearPipelineRun(tabId: number): Promise<void> {
  await chrome.storage.session.remove(storageKey(tabId));
}

/** Wires cleanup so a closed tab's run doesn't linger in session storage. Call once at startup. */
export function registerPipelineRunCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearPipelineRun(tabId);
  });
}
