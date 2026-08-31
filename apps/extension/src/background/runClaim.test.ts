import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import type { PipelineRunState } from '../lib/run';
import { getPipelineRun, setPipelineRun } from '../lib/tabStore/pipelineRun';
import { pipelineRunFixture } from '../lib/testFixtures';
import { type ClaimSpec, withRunClaim } from './runClaim';

const run = pipelineRunFixture();

function analysisSpec(): ClaimSpec<PipelineRunState> {
  return {
    step: 'analysis',
    mode: 'replace',
    cancellation: 'supersede',
    seed: (runId) => ({ ...run, runId, status: 'analyzing' }),
  };
}

function fillSpec(): ClaimSpec<PipelineRunState> {
  return {
    step: 'fill',
    mode: 'transition',
    cancellation: 'supersede',
    expectedRunId: run.runId,
    requires: (candidate) => candidate,
  };
}

function saveSpec(): ClaimSpec<PipelineRunState> {
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
});
