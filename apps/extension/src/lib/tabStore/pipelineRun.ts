/**
 * How a tab's Application Pipeline run is read and written — the store adapter over `lib/run/`.
 *
 * What a run *is*, which statuses exist and what may be done from each are the domain's
 * (`lib/run/`), one layer down. This module knows only where a run lives and how a write to it is
 * serialized: everything below is `chrome.storage.session` under the per-tab lock in
 * `tabStore/record.ts`.
 *
 * The split matters because the types used to live here. A run is read by the panel and written by
 * the service worker, so both processes imported a *storage* module to learn what a status is — and
 * the transition policy then had nowhere to live except the callers, which is how one rule came to
 * be stated in three of them. Persistence is not where a domain belongs.
 */
import {
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
 * Subscribes to writes affecting this tab's shared record without exposing that record's layout.
 * The projections make the event useful while the flags preserve which owner moved the write.
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
 *
 * `allowedStatuses` comes from `startableFrom(step)` in the domain rather than from a list the
 * caller writes — see `lib/run/status.ts`.
 *
 * `claimable` is a second condition on the run **as it stands before the patch**, evaluated inside
 * the same locked section. It exists because a precondition checked *after* the transition can only
 * reject a run the status already says is busy: `background/runClaim.ts` narrows with
 * `asAnalyzedRun`, and doing that on the returned snapshot left a run that failed to narrow stuck
 * in `filling`/`saving` with nothing to move it off. A condition that belongs to the claim has to
 * be part of the claim.
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
 * What a step that died with its worker is turned into, and why the candidate is told that.
 *
 * The wording differs per step because the consequence does: an interrupted analysis spent money
 * and produced nothing, an interrupted fill may have written half a form, and an interrupted save
 * may have created the record it was asked for. Keyed by step so a fourth one is a compile error
 * here rather than a step that silently recovers into nothing.
 */
const INTERRUPTED: Record<keyof typeof STEP_STATUS, RunFailureKind> = {
  analysis: 'temporary',
  fill: 'temporary',
  save: 'temporary',
};

/**
 * Turns operations owned by a previous MV3 service-worker instance into visible retry states.
 *
 * This runs once when a new worker starts, before that worker routes any message. No timeout is
 * involved: an in-progress status already present at startup necessarily belonged to the worker
 * instance Chrome stopped. Each repair is a status compare-and-transition, so idle runs are left
 * untouched and the recovery rule stays atomic with every normal pipeline claim.
 *
 * Driven by `STEP_STATUS` rather than by three hand-written pairs, so a step whose running status is
 * renamed cannot be left un-recovered — which would strand a run spinning forever.
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
