import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import type { PipelineRunState } from '../lib/run';
import { getPipelineRun, setPipelineRun } from '../lib/tabStore/pipelineRun';
import { pipelineRunFixture } from '../lib/testFixtures';
import { type ClaimSpec, withRunClaim } from './runClaim';

const run = pipelineRunFixture();

/** The `'transition'` half of {@link ClaimSpec} — what `onClaimed` is only ever offered on. */
type TransitionClaimSpec = Extract<ClaimSpec<PipelineRunState>, { mode: 'transition' }>;

function analysisSpec(): ClaimSpec<PipelineRunState> {
  return {
    step: 'analysis',
    mode: 'replace',
    cancellation: 'supersede',
    seed: (runId) => ({ ...run, runId, status: 'analyzing' }),
  };
}

function fillSpec(): TransitionClaimSpec {
  return {
    step: 'fill',
    mode: 'transition',
    cancellation: 'supersede',
    expectedRunId: run.runId,
    requires: (candidate) => candidate,
  };
}

function saveSpec(): TransitionClaimSpec {
  return {
    step: 'save',
    mode: 'transition',
    cancellation: 'none',
    expectedRunId: run.runId,
    requires: (candidate) => candidate,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('withRunClaim', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fakeChrome();
  });

  it('aborts an older cancellable claim when a newer replacement wins', async () => {
    const entered = deferred();
    let olderSignal!: AbortSignal;
    const older = withRunClaim(1, analysisSpec(), async (claim) => {
      olderSignal = claim.signal;
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        claim.signal.addEventListener('abort', () => reject(new Error('superseded')), {
          once: true,
        });
      });
      return null;
    });
    await entered.promise;

    await withRunClaim(1, analysisSpec(), async () => ({ status: 'review' }));
    await older;

    expect(olderSignal.aborted).toBe(true);
    expect(await getPipelineRun(1)).toMatchObject({ status: 'review' });
  });

  it('does not let a losing transition abort the operation that still owns the run', async () => {
    const entered = deferred();
    const release = deferred();
    let analysisSignal!: AbortSignal;
    const analysis = withRunClaim(1, analysisSpec(), async (claim) => {
      analysisSignal = claim.signal;
      entered.resolve();
      await release.promise;
      return { status: 'review' };
    });
    await entered.promise;
    const fillBody = vi.fn();

    await withRunClaim(1, fillSpec(), fillBody);

    expect(fillBody).not.toHaveBeenCalled();
    expect(analysisSignal.aborted).toBe(false);
    release.resolve();
    await analysis;
  });

  it("does not cancel a save whose policy is 'none', and drops its stale completion", async () => {
    await setPipelineRun(1, { ...run, status: 'filled' });
    const entered = deferred();
    const release = deferred();
    let saveSignal!: AbortSignal;
    const save = withRunClaim(1, saveSpec(), async (claim) => {
      saveSignal = claim.signal;
      entered.resolve();
      await release.promise;
      return { status: 'saved', applicationId: 'application-1' };
    });
    await entered.promise;

    await withRunClaim(1, analysisSpec(), async () => ({ status: 'review' }));
    expect(saveSignal.aborted).toBe(false);
    release.resolve();
    await save;

    expect(await getPipelineRun(1)).toMatchObject({ status: 'review', applicationId: null });
  });

  it('scopes ownership checks, intermediate checkpoints, and the final patch to the claimed run', async () => {
    await setPipelineRun(1, run);
    const replacement = { ...run, runId: 'replacement-run' };
    const observations: unknown[] = [];

    await withRunClaim(1, fillSpec(), async (claim) => {
      observations.push(await claim.stillOurs());
      observations.push(await claim.checkpoint({ filledFieldCount: 2 }));
      await setPipelineRun(1, replacement);
      observations.push(await claim.stillOurs());
      observations.push(await claim.checkpoint({ filledFieldCount: 3 }));
      return { filledFieldCount: 4 };
    });

    expect(observations).toEqual([true, true, false, false]);
    expect(await getPipelineRun(1)).toEqual(replacement);
  });

  it('checkpoints an acquired step failure instead of leaving a busy run', async () => {
    await setPipelineRun(1, run);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await withRunClaim(1, fillSpec(), async () => {
      throw new Error('page unavailable');
    });

    expect(await getPipelineRun(1)).toMatchObject({
      status: 'fill-error',
      failure: { step: 'fill', kind: 'unknown' },
    });
    expect(log).toHaveBeenCalledOnce();
  });

  describe('onClaimed', () => {
    it('reports a win synchronously, before body runs', async () => {
      await setPipelineRun(1, run);
      const onClaimed = vi.fn();
      const order: string[] = [];
      onClaimed.mockImplementation(() => order.push('claimed'));

      await withRunClaim(1, { ...fillSpec(), onClaimed }, async () => {
        order.push('body');
        return null;
      });

      expect(onClaimed).toHaveBeenCalledWith({ claimed: true });
      expect(order).toEqual(['claimed', 'body']);
    });

    it("reports 'busy' when the named run is already mid-step, and never calls body", async () => {
      // Same identity as `fillSpec()`'s `expectedRunId` — the refusal here is about status, not
      // which run this is.
      await setPipelineRun(1, { ...run, status: 'saving' });
      const onClaimed = vi.fn();
      const body = vi.fn();

      await withRunClaim(1, { ...fillSpec(), onClaimed }, body);

      expect(onClaimed).toHaveBeenCalledWith({ claimed: false, reason: 'busy' });
      expect(body).not.toHaveBeenCalled();
    });

    it("reports 'stale-run' when expectedRunId no longer names the tab's current run", async () => {
      await setPipelineRun(1, { ...run, runId: 'a-different-run', status: 'review' });
      const onClaimed = vi.fn();

      await withRunClaim(1, { ...fillSpec(), onClaimed }, vi.fn());

      expect(onClaimed).toHaveBeenCalledWith({ claimed: false, reason: 'stale-run' });
    });
  });
});
