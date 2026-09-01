/**
 * The Job Description at its own interface.
 *
 * These cases used to be reachable only by rendering the whole Autofill Tab and driving a textarea:
 * the scrape races in particular — a candidate typing while the content script reads the page, a
 * navigation landing mid-read — are about ordering, not about markup, and they are the two rules
 * most easily lost in a refactor.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import { TypedMessageEnvelopeSchema } from '../lib/messages';
import type { PostingReadOutcome } from '../lib/postingReader';
import { getJobContext, setJobContext } from '../lib/tabStore/jobContext';
import type { ActiveRun } from './useActiveRun';
import { useJobDescription } from './useJobDescription';

const OVERVIEW = 'https://job-boards.greenhouse.io/acme/jobs/1';
const APPLICATION = 'https://job-boards.greenhouse.io/acme/jobs/1#app';
const OTHER_JOB = 'https://job-boards.greenhouse.io/acme/jobs/2';

/** An `ActiveRun` with no run on it — the state every draft case starts from. */
function activeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    tabId: 1,
    tabUrl: OVERVIEW,
    changeToken: 0,
    run: null,
    status: null,
    review: { pill: null, canReview: false, outcome: null, notices: [] },
    beginCommand: vi.fn(() => vi.fn()),
    edit: vi.fn(),
    updateAnswer: vi.fn(),
    updateTailoredResume: vi.fn(),
    ...overrides,
  };
}

function scraped(text: string): PostingReadOutcome {
  return { status: 'success', candidate: { text, score: 10, source: 'dom' } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useJobDescription', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows the run's analyzed text once there is a run, not the draft", async () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const run = { jobDescription: 'As analyzed.', answers: [], tabUrl: OVERVIEW } as never;

    const { result } = renderHook(() => useJobDescription(activeRun({ run })));

    expect(result.current.text).toBe('As analyzed.');
  });

  it('mirrors an edited draft into the store, so a reopened panel still has it', async () => {
    fakeChrome({
      tab: { id: 1, url: OVERVIEW },
      sendMessage: (message, callback) => {
        const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
        if (typedMessage.type === 'UPDATE_JOB_CONTEXT') {
          void setJobContext(
            typedMessage.tabId,
            typedMessage.tabUrl,
            typedMessage.jobDescription,
            typedMessage.source,
          );
        }
        callback(undefined);
      },
    });

    const { result } = renderHook(() => useJobDescription(activeRun()));
    act(() => result.current.edit('Pasted posting.'));

    expect(result.current.text).toBe('Pasted posting.');
    await waitFor(async () =>
      expect((await getJobContext(1))?.jobDescription).toBe('Pasted posting.'),
    );
  });

  /** An edit belongs to the run once one exists — the store's draft is no longer authoritative. */
  it('writes onto the run rather than the draft while a run exists', () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const edit = vi.fn();
    const run = { jobDescription: 'As analyzed.', answers: [], tabUrl: OVERVIEW } as never;

    const { result } = renderHook(() => useJobDescription(activeRun({ run, edit })));
    act(() => result.current.edit('Corrected posting.'));

    expect(edit).toHaveBeenCalledWith({ answers: [], jobDescription: 'Corrected posting.' });
  });

  it('refuses an edit while the run is being saved', () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const edit = vi.fn();
    const run = { jobDescription: 'As analyzed.', answers: [], tabUrl: OVERVIEW } as never;

    const { result } = renderHook(() =>
      useJobDescription(activeRun({ run, edit, status: 'saving' })),
    );
    act(() => result.current.edit('Corrected posting.'));

    expect(edit).not.toHaveBeenCalled();
  });

  it('scrapes the posting into the draft for review', async () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const { result } = renderHook(() =>
      useJobDescription(activeRun(), () => Promise.resolve(scraped('Scraped posting.'))),
    );

    act(() => result.current.scrape());

    await waitFor(() => expect(result.current.text).toBe('Scraped posting.'));
    expect(result.current.source).toBe('scraped');
    expect(result.current.scrapeStatus).toEqual({ kind: 'success' });
  });

  /**
   * The race the candidate can actually lose work to: they keep typing while the content script
   * scans, and the scrape lands afterwards. Their text wins, always.
   */
  it('discards a scrape the candidate typed over while it was in flight', async () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const read = deferred<PostingReadOutcome>();
    const { result } = renderHook(() => useJobDescription(activeRun(), () => read.promise));

    act(() => result.current.scrape());
    act(() => result.current.edit('Typed while scraping.'));
    await act(async () => {
      read.resolve(scraped('Scraped posting.'));
      await read.promise;
    });

    expect(result.current.text).toBe('Typed while scraping.');
    expect(result.current.scrapeStatus).toEqual({ kind: 'idle' });
  });

  it('reports an unreachable page differently from one holding no posting', async () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });

    const unreachable = renderHook(() =>
      useJobDescription(activeRun(), () => Promise.reject(new Error('no frame'))),
    );
    act(() => unreachable.result.current.scrape());
    await waitFor(() =>
      expect(unreachable.result.current.scrapeStatus).toEqual({
        kind: 'error',
        reason: 'unavailable',
      }),
    );

    const empty = renderHook(() =>
      useJobDescription(activeRun(), () => Promise.resolve({ status: 'not-found' as const })),
    );
    act(() => empty.result.current.scrape());
    await waitFor(() =>
      expect(empty.result.current.scrapeStatus).toEqual({ kind: 'error', reason: 'not-found' }),
    );
  });

  it('refuses to scrape over text that is already there', () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const readPosting = vi.fn(() => Promise.resolve(scraped('Scraped posting.')));
    const { result } = renderHook(() => useJobDescription(activeRun(), readPosting));

    act(() => result.current.edit('Pasted posting.'));

    expect(result.current.canScrape).toBe(false);
    act(() => result.current.scrape());
    expect(readPosting).not.toHaveBeenCalled();
  });

  /**
   * The reason scoping is by Job Key rather than URL: candidates collect the posting on an ATS
   * overview route and analyze it on the application route.
   */
  it('retains the draft across another route for the same job', () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const props = { activeRun: activeRun() };
    const { result, rerender } = renderHook(({ activeRun: run }) => useJobDescription(run), {
      initialProps: props,
    });

    act(() => result.current.edit('Pasted posting.'));
    rerender({ activeRun: activeRun({ tabUrl: APPLICATION, changeToken: 1 }) });

    expect(result.current.text).toBe('Pasted posting.');
  });

  it('drops the draft when the tab moves to a different job', () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const { result, rerender } = renderHook(({ activeRun: run }) => useJobDescription(run), {
      initialProps: { activeRun: activeRun() },
    });

    act(() => result.current.edit('Pasted posting.'));
    rerender({ activeRun: activeRun({ tabUrl: OTHER_JOB, changeToken: 1 }) });

    expect(result.current.text).toBe('');
  });

  /**
   * The URL an analysis is filed under is the page the description was collected from, not
   * whichever route the candidate happens to be on when they press Analyze.
   */
  it('files the analysis under the page the draft was collected from', () => {
    fakeChrome({ tab: { id: 1, url: OVERVIEW } });
    const { result, rerender } = renderHook(({ activeRun: run }) => useJobDescription(run), {
      initialProps: { activeRun: activeRun() },
    });

    act(() => result.current.edit('Pasted posting.'));
    rerender({ activeRun: activeRun({ tabUrl: APPLICATION, changeToken: 1 }) });

    expect(result.current.analysisUrl).toBe(OVERVIEW);
  });
});
