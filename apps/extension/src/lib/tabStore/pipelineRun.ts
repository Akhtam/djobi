/**
 * The store adapter for a tab's pipeline run: where it lives (`chrome.storage.session`) and how
 * writes are serialized (`tabStore/record.ts`'s per-tab lock). What a run *is* and which
 * transitions are allowed belong to `lib/run/`.
 */
import type { TailoredResume } from '@djobi/shared';
import {
  canEditRun,
  hasRecordedFill,
  panelEditsOf,
  STEP_STATUS,
  type PipelineRunState,
  type PipelineStatus,
  type RunFailureKind,
} from '../run';
import {
  allTabIds,
  read,
  subscribeRunRecord,
  withTabLock,
  write,
  type RunRecordChange,
} from './record';

export type PipelineRunChange = RunRecordChange;

/**
 * Subscribes to this tab's record writes as run projections plus flags for which owner moved.
 */
export function subscribePipelineRun(
  tabId: number,
  onChange: (change: PipelineRunChange) => void,
): () => void {
  return subscribeRunRecord(tabId, onChange);
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
 * Merges `patch` onto the tab's run only if `runId` still matches, so completions from before a
 * navigation or re-analysis change nothing.
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
 * Applies a candidate's edit to run `runId`, inside the locked read-modify-write. Refused if the
 * run was replaced or isn't `editable` (e.g. a save is in flight). `saved` reverts to `filled` only
 * if the edited fields actually differ from what's stored.
 *
 * Returns whether it wrote — a refusal fires no `onChanged`, so `usePipelineRun` needs this.
 */
export async function applyPanelEdit(
  tabId: number,
  runId: string,
  edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & {
    tailoredResume?: TailoredResume | undefined;
  },
): Promise<{ applied: boolean; run: PipelineRunState | null }> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const run = state.run;
    if (!run || run.runId !== runId || !canEditRun(run.status)) {
      return { applied: false, run: null };
    }

    const before = panelEditsOf(run);
    // An absent `tailoredResume` leaves the stored one untouched; an explicit `undefined` means the
    // same.
    const { tailoredResume, ...rest } = edits;
    const after = {
      ...before,
      ...rest,
      ...(tailoredResume !== undefined ? { tailoredResume } : {}),
    };
    const changed = JSON.stringify(after) !== JSON.stringify(before);

    const updated: PipelineRunState = {
      ...run,
      ...after,
      ...(changed && hasRecordedFill(run.status) ? { status: STEP_STATUS.fill.succeeded } : {}),
    };
    await write(tabId, { ...state, run: updated });
    return { applied: true, run: updated };
  });
}

/**
 * Atomically claims the run by changing its status only if it's in `allowedStatuses` (from
 * `startableFrom(step)`), returning the updated snapshot or `null`. `claimable` is checked on the
 * run *before* the patch, in the same locked section, so a failed precondition never leaves a
 * busy status behind.
 */
export async function transitionPipelineRun(
  tabId: number,
  allowedStatuses: readonly PipelineStatus[],
  patch: Partial<Omit<PipelineRunState, 'runId'>>,
  claimable?: (run: PipelineRunState) => boolean,
): Promise<PipelineRunState | null> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    if (!state.run || !allowedStatuses.includes(state.run.status)) return null;
    if (claimable && !claimable(state.run)) return null;
    const run = { ...state.run, ...patch };
    await write(tabId, { ...state, run });
    return run;
  });
}

/**
 * What each step becomes if its worker died mid-step. Worded per step because the consequences
 * differ; keyed by step so a new one is a compile error.
 */
const INTERRUPTED: Record<keyof typeof STEP_STATUS, RunFailureKind> = {
  analysis: 'temporary',
  fill: 'temporary',
  save: 'temporary',
};

/**
 * Turns steps owned by a previous worker into retryable errors. Runs once at worker start, before
 * any message is routed: a busy status present then must belong to the dead worker. Each repair is
 * a compare-and-transition driven by `STEP_STATUS`.
 */
export async function recoverInterruptedPipelineRuns(): Promise<void> {
  const tabIds = await allTabIds();
  const steps = Object.entries(STEP_STATUS) as [
    keyof typeof STEP_STATUS,
    (typeof STEP_STATUS)[keyof typeof STEP_STATUS],
  ][];

  await Promise.all(
    tabIds.flatMap((tabId) =>
      steps.map(([step, { running, failed }]) =>
        transitionPipelineRun(tabId, [running], {
          status: failed,
          failure: { step, kind: INTERRUPTED[step] },
        }),
      ),
    ),
  );
}
