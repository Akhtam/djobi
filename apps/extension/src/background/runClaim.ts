/**
 * Acquiring a tab's pipeline run for one step and releasing it afterwards — one protocol for every
 * step: claim the slot, commit the "started" status, checkpoint a failure, release.
 *
 * - A claim supersedes (aborts) older steps only once it has *won* the run, so a losing Fill never
 *   kills a running Analysis.
 * - The precondition is checked before the busy status is committed, so a malformed run can't get
 *   stuck in `filling`/`saving`.
 *
 * Not centralised: **cancellation is per step** ({@link ClaimSpec}) — Save is `'none'`, since
 * aborting a write can't tell whether the row landed; and **identity gates** ({@link
 * RunClaim.stillOurs}) are placed by the step itself, adjacent to its irreversible effect.
 */
import { failureMessage } from '@djobi/shared';
import type { ClaimResult } from '../lib/messages';
import {
  type PipelineFailure,
  type PipelineRunState,
  type RunStep,
  startableFrom,
  STEP_STATUS,
} from '../lib/run';
import {
  getPipelineRun,
  patchPipelineRun,
  setPipelineRun,
  transitionPipelineRun,
} from '../lib/tabStore/pipelineRun';
import { pipelineFailure } from './pipelineFailure';

/** A patch a step returns to be checkpointed onto the run it claimed. */
type RunPatch = Partial<Omit<PipelineRunState, 'runId'>>;

/**
 * How a step takes the tab's run: `'replace'` mints a new run over whatever was there (Analysis
 * only); `'transition'` claims the existing run from a status it may start in.
 */
export type ClaimSpec<Run extends PipelineRunState> =
  | {
      step: 'analysis';
      mode: 'replace';
      /** Aborted by a later claim on the same tab. */
      cancellation: 'supersede';
      /** The run to write, given the identity this claim minted. */
      seed: (runId: string) => PipelineRunState & Run;
    }
  | {
      step: 'fill' | 'save';
      mode: 'transition';
      cancellation: 'supersede' | 'none';
      /** The run the panel meant; a late-delivered command must not claim a newer job's run. */
      expectedRunId?: string | undefined;
      /** The precondition (e.g. `asAnalyzedRun`), checked **before** `to` is committed. */
      requires: (run: PipelineRunState | null) => Run | null;
      /**
       * Called once with the claim's outcome, before `body` runs. `'busy'`: another step holds the
       * run; `'stale-run'`: `expectedRunId` isn't current. Not on `'replace'`, which can't lose.
       */
      onClaimed?: ((outcome: ClaimResult) => void) | undefined;
    };

/** The claimed run, and the two things a step may do with the claim while it holds it. */
export interface RunClaim<Run extends PipelineRunState> {
  /** The run as it read the moment it was claimed, narrowed by `requires`. */
  readonly run: Run;
  /**
   * Aborted when a later claim supersedes this one (never for `cancellation: 'none'`). Pass it to
   * every billed call — model calls, PDF renders.
   */
  readonly signal: AbortSignal;
  /**
   * Whether this claim still owns the tab's run. Call it immediately before an irreversible effect,
   * with no `await` in between.
   */
  stillOurs(): Promise<boolean>;
  /** Writes an intermediate patch onto this run. `false` when the run is no longer current. */
  checkpoint(patch: RunPatch): Promise<boolean>;
}

/** One step in flight for a tab. Only `cancellable` entries are aborted when superseded. */
interface LiveOperation {
  controller: AbortController;
  cancellable: boolean;
}

interface TabOperations {
  /**
   * Monotonic per tab. Assigned synchronously at the start of a claim, which is what orders them.
   */
  nextSeq: number;
  live: Map<number, LiveOperation>;
}

const operations = new Map<number, TabOperations>();

/**
 * Takes this step's place in the tab's order before anything is awaited, so a claim that hasn't won
 * yet can still be superseded by a later one that does.
 */
function enter(tabId: number, cancellable: boolean): { seq: number; controller: AbortController } {
  const tab = operations.get(tabId) ?? { nextSeq: 1, live: new Map<number, LiveOperation>() };
  operations.set(tabId, tab);

  const seq = tab.nextSeq++;
  const controller = new AbortController();
  tab.live.set(seq, { controller, cancellable });
  return { seq, controller };
}

/** Aborts every older cancellable step on this tab. Called only once this claim has won the run. */
function supersedeOlder(tabId: number, seq: number): void {
  const tab = operations.get(tabId);
  if (!tab) return;
  for (const [otherSeq, operation] of tab.live) {
    if (otherSeq < seq && operation.cancellable) operation.controller.abort();
  }
}

function leave(tabId: number, seq: number): void {
  const tab = operations.get(tabId);
  if (!tab) return;
  tab.live.delete(seq);
  // Drop the tab once nothing is in flight, so a browser session's worth of closed tabs can't
  // accumulate here.
  if (tab.live.size === 0) operations.delete(tabId);
}

/**
 * Runs one step against the tab's run. `body` returns the patch to checkpoint (or `null` for
 * nothing), written against the claimed identity so a completion that outlived its run changes
 * nothing.
 *
 * Resolves when done — success, failure or claim lost. Rejects only if a failure couldn't be
 * recorded (see {@link checkpointFailure}).
 */
export async function withRunClaim<Run extends PipelineRunState>(
  tabId: number,
  spec: ClaimSpec<Run>,
  body: (claim: RunClaim<Run>) => Promise<RunPatch | null>,
): Promise<void> {
  const cancellable = spec.cancellation === 'supersede';
  const { seq, controller } = enter(tabId, cancellable);
  // Known up front only for `'replace'` (this claim mints it). A storage fault during a transition
  // belongs to no run yet and goes to the worker's logging boundary.
  let runId: string | undefined;

  // `'replace'` can't lose, so it supersedes immediately and generation stops on the click;
  // `'transition'` must win first.
  if (spec.mode === 'replace') supersedeOlder(tabId, seq);

  try {
    let run: Run | null;
    if (spec.mode === 'replace') {
      runId = crypto.randomUUID();
      const seeded = spec.seed(runId);
      await setPipelineRun(tabId, seeded);
      run = seeded;
    } else {
      const claimed = await transitionPipelineRun(
        tabId,
        startableFrom(spec.step),
        { status: STEP_STATUS[spec.step].running, failure: null },
        (candidate) =>
          (spec.expectedRunId === undefined || candidate.runId === spec.expectedRunId) &&
          spec.requires(candidate) !== null,
      );
      run = spec.requires(claimed);
      if (run) {
        runId = run.runId;
        spec.onClaimed?.({ claimed: true });
      } else {
        // Distinguish a stale command from a busy run (one extra read, failure path only).
        const current = await getPipelineRun(tabId);
        const staleRun = spec.expectedRunId !== undefined && current?.runId !== spec.expectedRunId;
        spec.onClaimed?.({ claimed: false, reason: staleRun ? 'stale-run' : 'busy' });
      }
    }

    if (!run) return;

    // Won: supersede older steps. If a *later* step already won, this one stops here.
    supersedeOlder(tabId, seq);
    if (controller.signal.aborted) return;

    const claimedRunId = run.runId;
    const patch = await body({
      run,
      signal: controller.signal,
      stillOurs: async () => (await getPipelineRun(tabId))?.runId === claimedRunId,
      checkpoint: (update) => patchPipelineRun(tabId, claimedRunId, update),
    });

    if (patch) await patchPipelineRun(tabId, claimedRunId, patch);
  } catch (error) {
    // A newer claim owns the tab now. Its own checkpoint replaces this run, and cancellation is
    // expected control flow rather than a failure for either run to display.
    if (controller.signal.aborted) return;
    const failure = pipelineFailure(spec.step, error, controller.signal);
    // A failed member of a parallel group should not leave its siblings generating.
    if (cancellable) controller.abort(error);
    if (runId === undefined) throw error;
    console.error('[djobi] pipeline step failed', {
      step: spec.step,
      kind: failure.kind,
      detail: failureMessage(error),
      error,
    });
    await checkpointFailure(tabId, runId, failure, error);
  } finally {
    leave(tabId, seq);
  }
}

/**
 * Records a step's failure on the run so the panel shows a retryable error. If that write itself
 * fails, both causes are thrown together for the service worker to log.
 */
async function checkpointFailure(
  tabId: number,
  runId: string,
  failure: PipelineFailure,
  error: unknown,
): Promise<void> {
  try {
    await patchPipelineRun(tabId, runId, {
      status: STEP_STATUS[failure.step].failed,
      failure,
    });
  } catch (checkpointError) {
    throw new AggregateError(
      [error, checkpointError],
      `${failure.step} failed and its failure could not be stored`,
    );
  }
}
