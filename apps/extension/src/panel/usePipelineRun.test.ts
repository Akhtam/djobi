import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOfType } from './panelTestHarness';
import { fakeChrome } from '../lib/fakeChrome';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
import { TypedMessageEnvelopeSchema, typedMessageEnvelope } from '../lib/messages';
import { type PipelineRunState } from '../lib/run';
import { reportDetectedPage } from '../lib/tabStore/detectedPage';
import { clearTabState } from '../lib/tabStore/lifecycle';
import { getPipelineRun, patchPipelineRun, setPipelineRun } from '../lib/tabStore/pipelineRun';
import { usePipelineRun } from './usePipelineRun';
import { jobInfo, pipelineRunFixture } from '../lib/testFixtures';

const run = pipelineRunFixture({
  answers: [{ fieldId: 'f-why', question: 'Why us?', answer: 'Draft answer.', sourceStoryIds: [] }],
});

/** The shared in-memory `chrome.storage.session`, which fires `onChanged` on write as Chrome does. */
function stubChrome() {
  const { sendMessage } = fakeChrome({
    sendMessage: (message, callback) => {
      const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
      if (typedMessage.type === 'UPDATE_RUN') {
        void patchPipelineRun(
          typedMessage.tabId,
          typedMessage.runId,
          typedMessage.updates as Partial<PipelineRunState>,
        );
      }
      callback(undefined);
    },
  });

  /** Simulates `background/applicationPipeline.ts` checkpointing progress outside this hook. */
  const writeFromBackground = (tabId: number, next: PipelineRunState) =>
    setPipelineRun(tabId, next);

  /**
   * Simulates a write to the *rest* of the tab's key — what the content script's detection and the
   * API-oracle enrichment do, several times per page, sharing one key with the run.
   */
  const reportFrameFromContentScript = (tabId: number, _current: PipelineRunState | null) =>
    reportDetectedPage(tabId, 0, { fields: [] });

  return { sendMessage, writeFromBackground, reportFrameFromContentScript };
}

/** Lets the hook's promise-based initial store read and resulting React update settle. */
async function settleInitialRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('usePipelineRun', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('reads the stored run for its tab', async () => {
    stubChrome();
    await setPipelineRun(1, run);

    const { result } = renderHook(() => usePipelineRun(1));

    await settleInitialRead();
    expect(result.current.run).toEqual(run);
  });

  it('reports no run for a tab nothing has been analyzed on', async () => {
    stubChrome();

    const { result } = renderHook(() => usePipelineRun(1));

    await settleInitialRead();
    expect(result.current.run).toBeNull();
  });

  it("re-reads when the tracked tab changes, so one tab never shows another's review", async () => {
    stubChrome();
    await setPipelineRun(1, run);
    await setPipelineRun(2, { ...run, jobInfo: { ...jobInfo, company: 'Globex' } });

    const { result, rerender } = renderHook(({ tabId }) => usePipelineRun(tabId), {
      initialProps: { tabId: 1 },
    });
    await waitFor(() => expect(result.current.run?.jobInfo?.company).toBe('Acme'));

    rerender({ tabId: 2 });

    await waitFor(() => expect(result.current.run?.jobInfo?.company).toBe('Globex'));
  });

  it('reflects a run written from elsewhere, which is how Analysis Step progress arrives', async () => {
    const { writeFromBackground } = stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    await act(() => writeFromBackground(1, { ...run, status: 'filled', filledFieldCount: 3 }));

    expect(result.current.run).toMatchObject({ status: 'filled', filledFieldCount: 3 });
  });

  it.each([
    ['null', false],
    ['old', true],
  ])(
    'does not let a late %s initial read overwrite a newer storage event',
    async (_name, startsWithRun) => {
      const storage = fakeSessionStorage();
      fakeChrome({ storage });
      if (startsWithRun) await setPipelineRun(1, run);

      const get = storage.session.get;
      let resolveRead!: (value: Record<string, unknown>) => void;
      const initialRead = new Promise<Record<string, unknown>>((resolve) => {
        resolveRead = resolve;
      });
      let snapshot: Promise<Record<string, unknown>> | null = null;
      storage.session.get = vi.fn((key) => {
        if (snapshot === null) {
          snapshot = get(key);
          return initialRead;
        }
        return get(key);
      });
      const incoming = {
        ...run,
        runId: 'run-2',
        jobInfo: { ...jobInfo, company: 'Globex' },
      };
      const { result } = renderHook(() => usePipelineRun(1, 1));

      await act(() => setPipelineRun(1, incoming));
      expect(result.current.run).toEqual(incoming);

      await act(async () => resolveRead(await snapshot!));

      expect(result.current.run).toEqual(incoming);
    },
  );

  it('reflects storage removal instead of retaining a stale run after navigation', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(result.current.run).toEqual(run));

    await act(() => clearTabState(1));

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('shows an optimistic status immediately, so a click gets feedback before the background answers', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.beginCommand('fill'));

    expect(result.current.status).toBe('filling');
  });

  it('stands the optimistic status down once the store speaks, even when the run returns to the status it already had', async () => {
    // The case a status comparison cannot handle: a second Fill Step ends on `filled` having
    // started from `filled`, so the value alone never changes and an optimistic `filling` would
    // stand forever. This is why the hook watches for the update rather than for a different value.
    const { writeFromBackground } = stubChrome();
    const filled = { ...run, status: 'filled' as const, filledFieldCount: 3 };
    await setPipelineRun(1, filled);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.beginCommand('fill'));
    expect(result.current.status).toBe('filling');

    await act(() => writeFromBackground(1, filled));

    expect(result.current.status).toBe('filled');
  });

  it('keeps a standing optimistic status when an unrelated write touches the tab key', async () => {
    // Detected frames and the Job Context live under the same key as the run, and the content
    // script re-reports on every DOM change the form makes. Standing the optimism down for those
    // snapped the panel back to the stored status mid-click, for the whole gap this exists to cover.
    const { reportFrameFromContentScript } = stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.beginCommand('fill'));
    await act(() => reportFrameFromContentScript(1, run));

    expect(result.current.status).toBe('filling');
  });

  it('keeps a standing optimistic status while its own edit echo works back through the store', async () => {
    // An edit is a write to the run, so this is not covered by the frame case above: typing in the
    // Job Description editor during a fill would otherwise stand the fill's own optimism down.
    const { writeFromBackground } = stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.beginCommand('fill'));
    act(() =>
      result.current.edit({ answers: run.answers, jobDescription: 'edited while filling' }),
    );
    await waitFor(() => expect(result.current.run?.jobDescription).toBe('edited while filling'));

    expect(result.current.status).toBe('filling');

    // The background's own answer still stands it down.
    await act(() =>
      writeFromBackground(1, {
        ...run,
        status: 'filled',
        jobDescription: 'edited while filling',
        fillOutcome: 'complete',
        filledFieldCount: 2,
      }),
    );

    expect(result.current.status).toBe('filled');
  });

  it('keeps a standing optimistic status when an earlier keystroke echoes while a newer one is pending', async () => {
    // `edit` fires per keystroke, so two of them inside one storage round-trip leave the first's
    // echo arriving while the second is still outstanding. Recognized against the newest send
    // alone, that echo matched nothing and read as the background answering — standing the fill's
    // own optimism down, one keystroke narrower than the case above.
    const storage = fakeSessionStorage();
    const queued: {
      type: string;
      tabId: number;
      runId: string;
      updates: Partial<PipelineRunState>;
    }[] = [];
    const sendMessage = vi.fn((message, callback: () => void) => {
      const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
      if (typedMessage.type === 'UPDATE_RUN') queued.push(typedMessage);
      callback();
    });
    vi.stubGlobal('chrome', { storage, runtime: { sendMessage, lastError: undefined } });
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.beginCommand('fill'));
    act(() => result.current.edit({ answers: run.answers, jobDescription: 'A' }));
    act(() => result.current.edit({ answers: run.answers, jobDescription: 'AB' }));

    await act(async () => {
      await patchPipelineRun(1, queued[0].runId, queued[0].updates);
    });

    expect(result.current.status).toBe('filling');
    // And the newer keystroke is still what the user sees, rather than the echo's older text.
    expect(result.current.run?.jobDescription).toBe('AB');

    await act(async () => {
      await patchPipelineRun(1, queued[1].runId, queued[1].updates);
    });

    expect(result.current.status).toBe('filling');
    expect(result.current.run?.jobDescription).toBe('AB');
  });

  it('discards a delivery failure from a command a newer one has already superseded', async () => {
    // The callback is scoped to the attempt that raised it. Chrome can report an undelivered START
    // after the candidate has already started something else, and a shared `fail` stood *that*
    // step's status down — reporting an error for a step still running, and taking the spinner off
    // it. Only the current attempt may speak for the panel.
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    let undeliveredFill!: (message: string) => void;
    act(() => {
      undeliveredFill = result.current.beginCommand('fill');
    });
    act(() => {
      result.current.beginCommand('save');
    });
    act(() => undeliveredFill('Could not establish connection.'));

    expect(result.current.status).toBe('saving');
    expect(result.current.failure).toBeNull();
  });

  it('shows a delivery failure at once and stands the optimistic status down with it', async () => {
    // A START that never reached the worker produces no run and no storage event at all, so nothing
    // else will ever correct the spinner it was raised for.
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.beginCommand('fill'));
    act(() => result.current.beginCommand('fill')('Could not establish connection.'));

    expect(result.current.status).toBe('fill-error');
    expect(result.current.failure).toEqual({
      step: 'fill',
      kind: 'temporary',
    });
  });

  it('lets persisted progress supersede a delivery failure, for a worker that came back', async () => {
    const { writeFromBackground } = stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.beginCommand('fill')('Could not establish connection.'));
    await act(() => writeFromBackground(1, { ...run, status: 'filling' }));

    expect(result.current.status).toBe('filling');
    expect(result.current.failure).toBeNull();
  });

  it('keeps a delivery failure this panel raised when the stored run is one the caller rejects', async () => {
    // Navigation updates the panel's tracked URL before the worker's storage cleanup lands, so the
    // store still holds the previous job's run — which `useActiveRun` rejects. That run is not this
    // job's, but an undelivered START *is* this panel's news, and nothing else will ever report it:
    // rejecting the run and the status together left a spinner-less, error-less dead Analyze button.
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1, 1, () => false));
    await settleInitialRead();

    act(() => result.current.beginCommand('analysis')('Could not establish connection.'));

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBe('analyze-error');
    expect(result.current.failure).toEqual({
      step: 'analysis',
      kind: 'temporary',
    });
  });

  it("reports neither a rejected run nor its status, so one job never shows another's analysis", async () => {
    stubChrome();
    await setPipelineRun(1, { ...run, status: 'filled' });
    const { result } = renderHook(() => usePipelineRun(1, 1, () => false));

    await settleInitialRead();
    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it("reports the run's own checkpointed failure when no delivery failure stands", async () => {
    stubChrome();
    const failure = { step: 'analysis' as const, kind: 'temporary' as const };
    await setPipelineRun(1, { ...run, status: 'analyze-error', failure });
    const { result } = renderHook(() => usePipelineRun(1));

    await settleInitialRead();
    expect(result.current.failure).toEqual(failure);
  });

  it('drops a standing optimistic status when the tracked tab changes', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result, rerender } = renderHook(({ tabId }) => usePipelineRun(tabId), {
      initialProps: { tabId: 1 },
    });
    await settleInitialRead();
    act(() => result.current.beginCommand('fill'));

    rerender({ tabId: 2 });

    await settleInitialRead();
    expect(result.current.status).toBeNull();
  });

  it('hides a run and pending status immediately when its same-tab scope changes', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result, rerender } = renderHook(({ scopeToken }) => usePipelineRun(1, scopeToken), {
      initialProps: { scopeToken: 1 },
    });
    await waitFor(() => expect(result.current.run).toEqual(run));
    act(() => result.current.beginCommand('fill'));

    rerender({ scopeToken: 2 });

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('applies an edit locally at once, so a controlled textarea never lags a storage round-trip', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() =>
      result.current.edit({
        answers: [{ ...run.answers[0], answer: 'Edited.' }],
        jobDescription: 'Senior Engineer at Acme...',
      }),
    );

    expect(result.current.run?.answers[0].answer).toBe('Edited.');
  });

  it('persists an edit, so a reopened panel restores it', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() =>
      result.current.edit({
        answers: [{ ...run.answers[0], answer: 'Edited.' }],
        jobDescription: 'pasted',
      }),
    );

    // The write is async; wait for it to land before reopening, or the reopen races it.
    await vi.waitFor(async () => expect((await getPipelineRun(1))?.jobDescription).toBe('pasted'));

    const reopened = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(reopened.result.current.run).not.toBeNull());
    expect(reopened.result.current.run).toMatchObject({
      answers: [expect.objectContaining({ answer: 'Edited.' })],
      jobDescription: 'pasted',
    });
  });

  it('routes edits to the background with the run identity', async () => {
    const { sendMessage } = stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.edit({ answers: run.answers, jobDescription: 'edited' }));

    expect(sendMessage).toHaveBeenCalledWith(
      typedMessageEnvelope({
        type: 'UPDATE_RUN',
        tabId: 1,
        runId: 'run-1',
        updates: { answers: run.answers, jobDescription: 'edited' },
      }),
      expect.any(Function),
    );
  });

  it('sends a B-to-A undo while B is pending, even though A matches the last server echo', async () => {
    const storage = fakeSessionStorage();
    const queued: {
      type: string;
      tabId: number;
      runId: string;
      updates: Partial<PipelineRunState>;
    }[] = [];
    const sendMessage = vi.fn((message, callback: () => void) => {
      const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
      if (typedMessage.type === 'UPDATE_RUN') queued.push(typedMessage);
      callback();
    });
    vi.stubGlobal('chrome', {
      storage,
      runtime: { sendMessage, lastError: undefined },
    });
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.edit({ answers: run.answers, jobDescription: 'B' }));
    act(() => result.current.edit({ answers: run.answers, jobDescription: run.jobDescription }));

    expect(queued.map((message) => message.updates.jobDescription)).toEqual([
      'B',
      run.jobDescription,
    ]);

    await act(async () => {
      await patchPipelineRun(1, queued[0].runId, queued[0].updates);
    });
    expect(result.current.run?.jobDescription).toBe(run.jobDescription);
    await act(async () => {
      await patchPipelineRun(1, queued[1].runId, queued[1].updates);
    });
    expect((await getPipelineRun(1))?.jobDescription).toBe(run.jobDescription);
  });

  it("never writes the background's fields back, so an in-flight run can't be overwritten by this panel", async () => {
    stubChrome();
    // A run mid-Analysis Step, with results the background is the authority on.
    await setPipelineRun(1, { ...run, status: 'analyzing', filledFieldCount: 7 });
    const { result } = renderHook(() => usePipelineRun(1));
    await settleInitialRead();

    act(() => result.current.edit({ answers: run.answers, jobDescription: 'pasted' }));

    await vi.waitFor(async () => expect((await getPipelineRun(1))?.jobDescription).toBe('pasted'));
    // The edit landed, and everything the background owns came through untouched.
    expect(await getPipelineRun(1)).toMatchObject({
      jobDescription: 'pasted',
      status: 'analyzing',
      filledFieldCount: 7,
    });
  });

  describe('checking on a step that may have been interrupted', () => {
    // The failure this exists for: Chrome stops the worker mid-Analysis, the request dies (the
    // backend logs a 499), and the checkpoint is left saying `analyzing`. The repair sweep runs
    // when a worker *starts* — and an open panel watching a dead run sends nothing that starts one,
    // so it spins with no error and no retry until the candidate clicks something else.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /**
     * Lets the hook finish reading the store before the clock moves.
     *
     * Hydration is a promise, and the check interval only exists once its result has rendered.
     * Advancing first would create the interval after the time it was supposed to elapse in.
     */
    const hydrate = async (): Promise<void> => {
      await act(async () => {
        await Promise.resolve();
      });
    };

    it('asks the background to check on a run that claims to still be analyzing', async () => {
      const { sendMessage } = stubChrome();
      await setPipelineRun(7, { ...run, status: 'analyzing' });

      renderHook(() => usePipelineRun(7, 'https://boards.greenhouse.io/acme/jobs/1'));
      await hydrate();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(callsOfType(sendMessage, 'CHECK_RUN')).toEqual([
        [{ type: 'CHECK_RUN', tabId: 7 }, expect.any(Function)],
      ]);
    });

    it.each(['filling', 'saving'] as const)(
      'checks on an interrupted %s step too',
      async (status) => {
        // Fill and Save are shorter than Analysis but not instant, and both strand the panel the same
        // way — the recovery sweep has a branch for each of them for exactly this reason.
        const { sendMessage } = stubChrome();
        await setPipelineRun(7, { ...run, status });

        renderHook(() => usePipelineRun(7, 'https://boards.greenhouse.io/acme/jobs/1'));
        await hydrate();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });

        expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(1);
      },
    );

    it('leaves a settled run alone, however long the panel stays open', async () => {
      const { sendMessage } = stubChrome();
      await setPipelineRun(7, run); // 'review'

      renderHook(() => usePipelineRun(7, 'https://boards.greenhouse.io/acme/jobs/1'));
      await hydrate();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(0);
    });

    it('stops checking once the step reports it finished', async () => {
      const { sendMessage, writeFromBackground } = stubChrome();
      await setPipelineRun(7, { ...run, status: 'analyzing' });

      renderHook(() => usePipelineRun(7, 'https://boards.greenhouse.io/acme/jobs/1'));
      await hydrate();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(1);

      await act(() => writeFromBackground(7, run));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(1);
    });

    it('does not check on a step this panel has only just asked for', async () => {
      // An optimistic status stands for a request in flight from *this* panel. Nothing can have
      // been interrupted yet, and the recovery sweep would demote a run that is about to be written.
      const { sendMessage } = stubChrome();
      await setPipelineRun(7, run);

      const { result } = renderHook(() =>
        usePipelineRun(7, 'https://boards.greenhouse.io/acme/jobs/1'),
      );
      await hydrate();
      act(() => result.current.beginCommand('fill'));
      expect(result.current.status).toBe('filling');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(0);
    });
  });
});
