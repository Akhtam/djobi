/**
 * Acquiring a tab's Application Pipeline run for one step, and releasing it afterwards.
 *
 * Every step used to hand-roll this: claim the tab's cancellable slot, write the status that says
 * the step has started, re-check the run's identity, checkpoint a failure, release the slot. Three
 * copies of one protocol, and they had drifted in three ways that were defects rather than
 * differences.
 *
 * - **The Analysis Step claimed before its first `await` and the Fill Step claimed after one.** A
 *   Fill that resumed late aborted an Analysis that had started after it, and the Analysis then
 *   returned silently on `signal.aborted` — leaving the run wedged at `analyzing` with `failure:
 *   null`, which the panel renders as a spinner with no error and no retry. The suite could not see
 *   it: every fake in the pipeline's tests resolved regardless of its `AbortSignal`, so the abort
 *   path never ran.
 * - **The Save Step claimed nothing at all**, so it had no signal and no release.
 * - **The Fill and Save Steps committed `filling`/`saving` before narrowing the run** with
 *   `asAnalyzedRun`, so a run that failed to narrow was left in a busy status nothing would ever
 *   move off.
 *
 * What is *not* centralised here matters as much as what is.
 *
 * **Cancellation is a per-step policy, not a property of the claim** — see {@link ClaimSpec}. The
 * Save Step is `'none'`: aborting an in-flight `POST /applications` cannot establish whether the row
 * committed, and a run whose `applicationId` is still null writes a *second* Application on the next
 * save. That only becomes revisitable behind an idempotency key.
 *
 * **Where an identity gate sits is the step's own business.** {@link RunClaim.stillOurs} is offered,
 * not applied: the Fill Step's gates are correct because no `await` separates them from the
 * irreversible page command, and a module that called them on the step's behalf would have to
 * guess that placement.
 */
import { failureMessage } from '@djobi/shared';
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
 * How a step takes the tab's run.
 *
 * `'replace'` mints a new run identity over whatever the tab held — the Analysis Step, which is the
 * only entry point that starts a run. `'transition'` claims an existing one, and only from a status
 * it is allowed to start in.
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
      /**
       * The run the panel meant, when it named one.
       *
       * A command that was delayed in delivery would otherwise claim whichever run happens to be
       * current when it lands, which after a re-analysis is a different job's. `UPDATE_RUN` has
       * always carried its `runId`; these two were the exception.
       */
      expectedRunId?: string;
      /**
       * The precondition the run must already satisfy, checked **before** `to` is committed.
       *
       * `asAnalyzedRun` is what both callers pass. Checking it after the commit is what left a
       * malformed run stuck in a busy status.
       */
      requires: (run: PipelineRunState | null) => Run | null;
    };

/** The claimed run, and the two things a step may do with the claim while it holds it. */
export interface RunClaim<Run extends PipelineRunState> {
  /** The run as it read the moment it was claimed, narrowed by `requires`. */
  readonly run: Run;
  /**
   * Aborted when a later claim supersedes this one. Never aborted for `cancellation: 'none'`.
   *
   * Pass it to every call that bills for work nobody will read — a model call, a PDF render.
   */
  readonly signal: AbortSignal;
  /**
   * Whether this claim still owns the tab's run.
   *
   * Call it immediately before an irreversible effect, with no `await` in between: that adjacency
   * is the whole guarantee, and it cannot be established from outside the step.
   */
  stillOurs(): Promise<boolean>;
  /** Writes an intermediate patch onto this run. `false` when the run is no longer current. */
  checkpoint(patch: RunPatch): Promise<boolean>;
}

/**
 * One step in flight for a tab, and its place in the tab's ordering.
 *
 * `cancellable` is what keeps a Save out of everyone else's reach: a superseding claim aborts only
 * the entries that opted in.
 */
interface LiveOperation {
  controller: AbortController;
  cancellable: boolean;
}

interface TabOperations {
  /** Monotonic per tab. Assigned synchronously at the start of a claim, which is what orders them. */
  nextSeq: number;
  live: Map<number, LiveOperation>;
}

const operations = new Map<number, TabOperations>();

/**
 * Takes this step's place in the tab's order, before anything is awaited.
 *
 * The sequence is assigned here rather than when the run is won, because "who started later" is the
 * only question the abort rule can answer synchronously — and a claim that has not yet won must
 * still be superseded by one that does.
 */
function enter(tabId: number, cancellable: boolean): { seq: number; controller: AbortController } {
  const tab = operations.get(tabId) ?? { nextSeq: 1, live: new Map<number, LiveOperation>() };
  operations.set(tabId, tab);

  const seq = tab.nextSeq++;
  const controller = new AbortController();
  tab.live.set(seq, { controller, cancellable });
  return { seq, controller };
}

/**
 * Aborts every older cancellable step on this tab.
 *
 * Called **only once this claim has actually won the run**, which is the ordering fix: a step that
 * loses its transition — a Fill commanded while an Analysis is running, a Fill whose run was
 * replaced — now aborts nobody, where claiming up front made it kill the incumbent and then do
 * nothing itself.
 */
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
 * Runs one step against the tab's run, holding the run for as long as it takes.
 *
 * `body` receives the claim and returns the patch that records what it did, or `null` when it
 * decided there was nothing to record — a superseded Fill, for instance. The patch is checkpointed
 * against the claimed identity, so a completion that outlived its run changes nothing.
 *
 * Resolves when the step is done, whether it succeeded, failed, or never got the run at all.
 * Rejects only when a failure could not even be recorded — see {@link checkpointFailure}.
 */
export async function withRunClaim<Run extends PipelineRunState>(
  tabId: number,
  spec: ClaimSpec<Run>,
  body: (claim: RunClaim<Run>) => Promise<RunPatch | null>,
): Promise<void> {
  const cancellable = spec.cancellation === 'supersede';
  const { seq, controller } = enter(tabId, cancellable);
  // Known before the acquisition only in `'replace'` mode, where this claim mints it. A storage
  // fault while writing the initial run is still this run's failure to report; a fault while
  // *transitioning* belongs to no run yet and is returned to the worker's logging boundary.
  let runId: string | undefined;

  // A `'replace'` claim cannot fail to win the run — Analyze takes the tab from whatever was there
  // — so it supersedes at once rather than a storage round-trip later, and whatever was generating
  // stops the moment the candidate clicks. A `'transition'` claim has to win first; that is the
  // whole ordering fix, so the two are deliberately not the same line.
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
      if (run) runId = run.runId;
    }

    if (!run) return;

    // Won. Everything that started earlier is superseded — a no-op for a replace claim, which did
    // this above. And if something that started *later* has already won, this claim is the
    // superseded one and stops before it can act.
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
 * Records a step's failure on the run, so the panel shows an error the candidate can retry from
 * rather than a status that never resolves.
 *
 * If the checkpoint write *itself* rejects, both causes are thrown together: the operational
 * failure would otherwise be lost to a storage fault that has nothing to do with it. Nothing here
 * catches that — `background/router.ts` returns this task to `background/service-worker.ts`, whose
 * listener is the one place a terminal rejection is logged.
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
