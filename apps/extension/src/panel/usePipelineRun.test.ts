import type { JobInfo, TailoredResume } from '@djobi/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
import {
  getPipelineRun,
  patchPipelineRun,
  setPipelineRun,
  storageKey,
  type PipelineRunState,
} from '../lib/tabStore';
import { usePipelineRun } from './usePipelineRun';

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

const tailoredResume: TailoredResume = { skills: [], workExperience: [] };

const run: PipelineRunState = {
  runId: 'run-1',
  status: 'review',
  tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  jobPageData: { fields: [] },
  jobDescription: 'Senior Engineer at Acme...',
  jobInfo,
  tailoredResume,
  answers: [{ fieldId: 'f-why', question: 'Why us?', answer: 'Draft answer.', sourceStoryIds: [] }],
  failure: null,
  unresolvedRequiredFields: [],
  filledFieldCount: 0,
  fillOutcome: null,
  applicationId: null,
  duplicateOf: null,
};

/** The shared in-memory `chrome.storage.session`, which fires `onChanged` on write as Chrome does. */
function stubChrome() {
  const storage = fakeSessionStorage();
  const sendMessage = vi.fn(
    (
      message: {
        type: string;
        tabId: number;
        runId: string;
        updates: Partial<PipelineRunState>;
      },
      callback: () => void,
    ) => {
      if (message.type === 'UPDATE_RUN') {
        void patchPipelineRun(message.tabId, message.runId, message.updates);
      }
      callback();
    },
  );
  vi.stubGlobal('chrome', { storage, runtime: { sendMessage, lastError: undefined } });

  /**
   * Simulates `background/applicationPipeline.ts` checkpointing progress from outside this hook.
   * Returns nothing on purpose: the fake notifies its listeners synchronously, and handing `act` a
   * promise would put it in async mode and defer the very re-render the caller asserts on next.
   */
  const writeFromBackground = (tabId: number, next: PipelineRunState): void => {
    void storage.session.set({ [storageKey(tabId)]: { frames: {}, run: next } });
  };

  return { sendMessage, writeFromBackground };
}

describe('usePipelineRun', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('reads the stored run for its tab', async () => {
    stubChrome();
    await setPipelineRun(1, run);

    const { result } = renderHook(() => usePipelineRun(1));

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.run).toEqual(run);
  });

  it('reports no run for a tab nothing has been analyzed on', async () => {
    stubChrome();

    const { result } = renderHook(() => usePipelineRun(1));

    await waitFor(() => expect(result.current.hydrated).toBe(true));
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
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => writeFromBackground(1, { ...run, status: 'filled', filledFieldCount: 3 }));

    expect(result.current.run).toMatchObject({ status: 'filled', filledFieldCount: 3 });
  });

  it.each([
    ['null', {}],
    ['old', { [storageKey(1)]: { frames: {}, run } }],
  ])(
    'does not let a late %s initial read overwrite a newer storage event',
    async (_name, snapshot) => {
      const storage = fakeSessionStorage();
      let resolveRead!: (value: Record<string, unknown>) => void;
      const initialRead = new Promise<Record<string, unknown>>((resolve) => {
        resolveRead = resolve;
      });
      storage.session.get = vi.fn(() => initialRead);
      vi.stubGlobal('chrome', {
        storage,
        runtime: { sendMessage: vi.fn(), lastError: undefined },
      });
      const incoming = {
        ...run,
        runId: 'run-2',
        jobInfo: { ...jobInfo, company: 'Globex' },
      };
      const { result } = renderHook(() => usePipelineRun(1, 1));

      act(() => void storage.session.set({ [storageKey(1)]: { frames: {}, run: incoming } }));
      expect(result.current.run).toEqual(incoming);
      expect(result.current.hydrated).toBe(true);

      await act(async () => resolveRead(snapshot));

      expect(result.current.run).toEqual(incoming);
    },
  );

  it('reflects storage removal instead of retaining a stale run after navigation', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(result.current.run).toEqual(run));

    act(() => void chrome.storage.session.remove(storageKey(1)));

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('shows an optimistic status immediately, so a click gets feedback before the background answers', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.begin('filling'));

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
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.begin('filling'));
    expect(result.current.status).toBe('filling');

    act(() => writeFromBackground(1, filled));

    expect(result.current.status).toBe('filled');
  });

  it('drops a standing optimistic status when the tracked tab changes', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result, rerender } = renderHook(({ tabId }) => usePipelineRun(tabId), {
      initialProps: { tabId: 1 },
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => result.current.begin('filling'));

    rerender({ tabId: 2 });

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.status).toBeNull();
  });

  it('hides a run and pending status immediately when its same-tab scope changes', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result, rerender } = renderHook(({ scopeToken }) => usePipelineRun(1, scopeToken), {
      initialProps: { scopeToken: 1 },
    });
    await waitFor(() => expect(result.current.run).toEqual(run));
    act(() => result.current.begin('filling'));

    rerender({ scopeToken: 2 });

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
    expect(result.current.hydrated).toBe(false);
  });

  it('applies an edit locally at once, so a controlled textarea never lags a storage round-trip', async () => {
    stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

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
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() =>
      result.current.edit({
        answers: [{ ...run.answers[0], answer: 'Edited.' }],
        jobDescription: 'pasted',
      }),
    );

    // The write is async; wait for it to land before reopening, or the reopen races it.
    await vi.waitFor(async () => expect((await getPipelineRun(1))?.jobDescription).toBe('pasted'));

    const reopened = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(reopened.result.current.hydrated).toBe(true));
    expect(reopened.result.current.run).toMatchObject({
      answers: [expect.objectContaining({ answer: 'Edited.' })],
      jobDescription: 'pasted',
    });
  });

  it('routes edits to the background with the run identity', async () => {
    const { sendMessage } = stubChrome();
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.edit({ answers: run.answers, jobDescription: 'edited' }));

    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: 'UPDATE_RUN',
        tabId: 1,
        runId: 'run-1',
        updates: { answers: run.answers, jobDescription: 'edited' },
      },
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
      queued.push(message);
      callback();
    });
    vi.stubGlobal('chrome', {
      storage,
      runtime: { sendMessage, lastError: undefined },
    });
    await setPipelineRun(1, run);
    const { result } = renderHook(() => usePipelineRun(1));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

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
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.edit({ answers: run.answers, jobDescription: 'pasted' }));

    await vi.waitFor(async () => expect((await getPipelineRun(1))?.jobDescription).toBe('pasted'));
    // The edit landed, and everything the background owns came through untouched.
    expect(await getPipelineRun(1)).toMatchObject({
      jobDescription: 'pasted',
      status: 'analyzing',
      filledFieldCount: 7,
    });
  });
});
