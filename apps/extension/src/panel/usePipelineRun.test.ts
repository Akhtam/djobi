import type { JobInfo, TailoredResume } from '@djobi/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
import { getPipelineRun, setPipelineRun, storageKey, type PipelineRunState } from '../lib/tabStore';
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
  vi.stubGlobal('chrome', { storage });

  /**
   * Simulates `background/applicationPipeline.ts` checkpointing progress from outside this hook.
   * Returns nothing on purpose: the fake notifies its listeners synchronously, and handing `act` a
   * promise would put it in async mode and defer the very re-render the caller asserts on next.
   */
  const writeFromBackground = (tabId: number, next: PipelineRunState): void => {
    void storage.session.set({ [storageKey(tabId)]: { frames: {}, run: next } });
  };

  return { writeFromBackground };
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
