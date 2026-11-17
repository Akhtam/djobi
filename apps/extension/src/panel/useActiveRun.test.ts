/**
 * `useActiveRun` is the panel's one handle on a run: the active tab, that tab's stored run filtered
 * to the job being shown, this panel's optimistic status and edits, and the check on a step whose
 * worker may have died. Tested through that interface only, against the in-memory `chrome` fake.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOfType } from './panelTestHarness';
import { fakeChrome, type FakeChromeOptions } from '../lib/fakeChrome';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
import { TypedMessageEnvelopeSchema, typedMessageEnvelope } from '../lib/messages';
import { type PipelineRunState } from '../lib/run';
import { reportDetectedPage } from '../lib/tabStore/detectedPage';
import { clearTabState } from '../lib/tabStore/lifecycle';
import {
  applyPanelEdit,
  getPipelineRun,
  patchPipelineRun,
  setPipelineRun,
} from '../lib/tabStore/pipelineRun';
import { useActiveRun } from './useActiveRun';
import { jobInfo, pipelineRunFixture } from '../lib/testFixtures';

const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/1';
const OTHER_JOB_URL = 'https://boards.greenhouse.io/globex/jobs/2';

const run = pipelineRunFixture({
  tabUrl: JOB_URL,
  answers: [
    { fieldId: 'f-why', question: 'Why us?', answer: 'Draft answer.', sourceStoryIds: [] },
    { fieldId: 'f-when', question: 'When can you start?', answer: 'Soon.', sourceStoryIds: [] },
  ],
});

function runAt(status: PipelineRunState['status']): PipelineRunState {
  return { ...run, status };
}

type SendMessage = NonNullable<FakeChromeOptions['sendMessage']>;

/** `UPDATE_RUN` reaches the store, as the service worker's routing does; the rest reply nothing. */
const routeToStore: SendMessage = (message, callback) => {
  const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
  if (typedMessage.type === 'UPDATE_RUN') {
    void applyPanelEdit(typedMessage.tabId, typedMessage.runId, typedMessage.updates).then(
      ({ applied }) => callback({ applied }),
    );
    return;
  }
  callback(undefined);
};

/** A fake Chrome whose active tab 1 shows `JOB_URL`. */
function stubChrome(options: Omit<FakeChromeOptions, 'tab'> = {}) {
  const chromeFake = fakeChrome({
    tab: { id: 1, url: JOB_URL },
    sendMessage: routeToStore,
    ...options,
  });

  /** Simulates `background/applicationPipeline.ts` checkpointing progress outside this hook. */
  const writeFromBackground = (next: PipelineRunState) => setPipelineRun(1, next);

  /**
   * Simulates a write to the *rest* of the tab's key — what the content script's detection and the
   * API-oracle enrichment do, several times per page, sharing one key with the run.
   */
  const reportFrameFromContentScript = () => reportDetectedPage(1, 0, { fields: [] });

  return { ...chromeFake, writeFromBackground, reportFrameFromContentScript };
}

/** `UPDATE_RUN` messages are recorded and acknowledged as applied, but never written. */
function holdEdits() {
  const queued: { runId: string; updates: Partial<PipelineRunState> }[] = [];
  const sendMessage: SendMessage = (message, callback) => {
    const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
    if (typedMessage.type === 'UPDATE_RUN') {
      // Parsed JSON never carries an explicit `undefined`, so the optional fields are simply absent.
      queued.push({
        runId: typedMessage.runId,
        updates: typedMessage.updates as Partial<PipelineRunState>,
      });
      callback({ applied: true });
      return;
    }
    callback(undefined);
  };
  /** Writes the `index`th held edit, so its echo arrives. */
  const echo = (index: number) => patchPipelineRun(1, queued[index]!.runId, queued[index]!.updates);
  return { queued, sendMessage, echo };
}

/** The notices that report a failed step — how a failure reaches the panel. */
function failureNotices(activeRun: ReturnType<typeof useActiveRun>) {
  return activeRun.review.notices.filter((notice) => 'reason' in notice);
}

/** Lets the tab query, the view's promise-based store read, and the resulting renders settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Mounts the hook with `stored` on tab 1 (if any), and waits for the store read to land. */
async function mount(stored: PipelineRunState | null = run) {
  if (stored) await setPipelineRun(1, stored);
  const hook = renderHook(() => useActiveRun(true));
  if (stored && stored.tabUrl === JOB_URL) {
    await waitFor(() => expect(hook.result.current.run?.runId).toBe(stored.runId));
  } else {
    await settle();
  }
  return hook.result;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useActiveRun: reading the run', () => {
  it('reads the stored run for the active tab', async () => {
    stubChrome();
    const result = await mount();

    expect(result.current.tabId).toBe(1);
    expect(result.current.run).toEqual(run);
  });

  it('tracks nothing until enabled', async () => {
    stubChrome();
    await setPipelineRun(1, run);

    const { result } = renderHook(() => useActiveRun(false));
    await settle();

    expect(result.current.tabId).toBeNull();
    expect(result.current.run).toBeNull();
  });

  it('reports no run for a tab nothing has been analyzed on', async () => {
    stubChrome();
    const result = await mount(null);

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it("re-reads when the active tab changes, so one tab never shows another's review", async () => {
    const { knowTab, activate } = stubChrome();
    await setPipelineRun(2, {
      ...run,
      tabUrl: OTHER_JOB_URL,
      jobInfo: { ...jobInfo, company: 'Globex' },
    });
    const result = await mount();
    expect(result.current.run?.jobInfo?.company).toBe('Acme');

    knowTab(2, OTHER_JOB_URL);
    act(() => activate(2));

    await waitFor(() => expect(result.current.run?.jobInfo?.company).toBe('Globex'));
  });

  it('reflects a run written from elsewhere, which is how Analysis Step progress arrives', async () => {
    const { writeFromBackground } = stubChrome();
    const result = await mount();

    await act(() => writeFromBackground({ ...run, status: 'filled', filledFieldCount: 3 }));

    expect(result.current.run).toMatchObject({ status: 'filled', filledFieldCount: 3 });
  });

  it.each([
    ['null', false],
    ['old', true],
  ])(
    'does not let a late %s initial read overwrite a newer storage event',
    async (_name, startsWithRun) => {
      const storage = fakeSessionStorage();
      stubChrome({ storage });
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
      const incoming = { ...run, runId: 'run-2', jobInfo: { ...jobInfo, company: 'Globex' } };
      const { result } = renderHook(() => useActiveRun(true));
      await waitFor(() => expect(snapshot).not.toBeNull());

      await act(() => setPipelineRun(1, incoming));
      expect(result.current.run).toEqual(incoming);

      await act(async () => resolveRead(await snapshot!));

      expect(result.current.run).toEqual(incoming);
    },
  );

  it('reflects storage removal instead of retaining a stale run after navigation', async () => {
    stubChrome();
    const result = await mount();

    await act(() => clearTabState(1));

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it("reports the run's own checkpointed failure when no delivery failure stands", async () => {
    stubChrome();
    const failure = { step: 'analysis' as const, kind: 'temporary' as const };
    const result = await mount({ ...run, status: 'analyze-error', failure });

    expect(result.current.review.notices).toEqual([
      expect.objectContaining({ kind: 'analyze-failed', reason: 'temporary' }),
    ]);
  });
});

describe("useActiveRun: another job's run", () => {
  // Navigation updates the URL before the worker's storage cleanup lands, so the store can still
  // hold the previous job's run for this tab.

  it("reports neither the run nor its status, so one job never shows another's analysis", async () => {
    stubChrome();
    const result = await mount({ ...run, status: 'filled', tabUrl: OTHER_JOB_URL });

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('keeps a delivery failure this panel raised while the stored run is not this job', async () => {
    // That run is not this job's, but an undelivered START *is* this panel's news, and nothing else
    // will ever report it: hiding the run and the status together left a spinner-less, error-less
    // dead Analyze button.
    stubChrome();
    const result = await mount({ ...run, tabUrl: OTHER_JOB_URL });

    act(() => result.current.beginCommand('analysis')());

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBe('analyze-error');
    expect(result.current.review.notices).toEqual([
      expect.objectContaining({ kind: 'analyze-failed', reason: 'temporary' }),
    ]);
  });

  it('hides the run and a pending status at once when the tab navigates to another job', async () => {
    const { navigate } = stubChrome();
    const result = await mount();
    act(() => result.current.beginCommand('fill'));

    act(() => navigate(1, OTHER_JOB_URL));

    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
  });
});

describe('useActiveRun: optimistic status', () => {
  it('shows an optimistic status immediately, so a click gets feedback before the background answers', async () => {
    stubChrome();
    const result = await mount();

    act(() => result.current.beginCommand('fill'));

    expect(result.current.status).toBe('filling');
  });

  it('stands the optimistic status down once the store speaks, even when the run returns to the status it already had', async () => {
    // The case a status comparison cannot handle: a second Fill Step ends on `filled` having
    // started from `filled`, so the value alone never changes and an optimistic `filling` would
    // stand forever. This is why the hook watches for the update rather than for a different value.
    const { writeFromBackground } = stubChrome();
    const filled = { ...run, status: 'filled' as const, filledFieldCount: 3 };
    const result = await mount(filled);

    act(() => result.current.beginCommand('fill'));
    expect(result.current.status).toBe('filling');

    await act(() => writeFromBackground(filled));

    expect(result.current.status).toBe('filled');
  });

  it('keeps a standing optimistic status when an unrelated write touches the tab key', async () => {
    // Detected frames and the Job Context live under the same key as the run, and the content
    // script re-reports on every DOM change the form makes. Standing the optimism down for those
    // snapped the panel back to the stored status mid-click, for the whole gap this exists to cover.
    const { reportFrameFromContentScript } = stubChrome();
    const result = await mount();

    act(() => result.current.beginCommand('fill'));
    await act(() => reportFrameFromContentScript());

    expect(result.current.status).toBe('filling');
  });

  it('keeps a standing optimistic status while its own edit echo works back through the store', async () => {
    // An edit is a write to the run, so this is not covered by the frame case above: typing in the
    // Job Description editor during a fill would otherwise stand the fill's own optimism down.
    const { writeFromBackground } = stubChrome();
    const result = await mount();

    act(() => result.current.beginCommand('fill'));
    act(() =>
      result.current.edit(run.runId, {
        answers: run.answers,
        jobDescription: 'edited while filling',
      }),
    );
    await waitFor(() => expect(result.current.run?.jobDescription).toBe('edited while filling'));

    expect(result.current.status).toBe('filling');

    // The background's own answer still stands it down.
    await act(() =>
      writeFromBackground({
        ...run,
        status: 'filled',
        jobDescription: 'edited while filling',
        fillOutcome: 'complete',
        filledFieldCount: 2,
      }),
    );

    expect(result.current.status).toBe('filled');
  });

  it('keeps a standing optimistic status while a tailoredResume edit echoes back through the store', async () => {
    // tailoredResume is editable while filling (see lib/run/status.ts's FACTS table) — a candidate
    // tweaking a bullet in ResumeReview mid-fill must not stand the fill's own optimism down either.
    const { writeFromBackground } = stubChrome();
    const result = await mount();
    const tailoredResume = { skills: ['Rust'], workExperience: [] };

    act(() => result.current.beginCommand('fill'));
    act(() => result.current.updateTailoredResume(run.runId, tailoredResume));
    await waitFor(() => expect(result.current.run?.tailoredResume?.skills).toEqual(['Rust']));

    expect(result.current.status).toBe('filling');

    // The background's own answer still stands it down.
    await act(() =>
      writeFromBackground({
        ...run,
        status: 'filled',
        tailoredResume,
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
    const held = holdEdits();
    stubChrome({ sendMessage: held.sendMessage });
    const result = await mount();

    act(() => result.current.beginCommand('fill'));
    act(() => result.current.edit(run.runId, { answers: run.answers, jobDescription: 'A' }));
    act(() => result.current.edit(run.runId, { answers: run.answers, jobDescription: 'AB' }));

    await act(() => held.echo(0));

    expect(result.current.status).toBe('filling');
    // And the newer keystroke is still what the user sees, rather than the echo's older text.
    expect(result.current.run?.jobDescription).toBe('AB');

    await act(() => held.echo(1));

    expect(result.current.status).toBe('filling');
    expect(result.current.run?.jobDescription).toBe('AB');
  });

  it('discards a delivery failure from a command a newer one has already superseded', async () => {
    // The callback is scoped to the attempt that raised it. Chrome can report an undelivered START
    // after the candidate has already started something else, and a shared `fail` stood *that*
    // step's status down — reporting an error for a step still running, and taking the spinner off
    // it. Only the current attempt may speak for the panel.
    stubChrome();
    const result = await mount();

    let undeliveredFill!: () => void;
    act(() => {
      undeliveredFill = result.current.beginCommand('fill');
    });
    act(() => {
      result.current.beginCommand('save');
    });
    act(() => undeliveredFill());

    expect(result.current.status).toBe('saving');
    expect(failureNotices(result.current)).toEqual([]);
  });

  it('shows a delivery failure at once and stands the optimistic status down with it', async () => {
    // A START that never reached the worker produces no run and no storage event at all, so nothing
    // else will ever correct the spinner it was raised for.
    stubChrome();
    const result = await mount();

    act(() => result.current.beginCommand('fill'));
    act(() => result.current.beginCommand('fill')());

    expect(result.current.status).toBe('fill-error');
    expect(result.current.review.notices).toEqual([
      expect.objectContaining({ kind: 'fill-failed', reason: 'temporary' }),
    ]);
  });

  it('lets persisted progress supersede a delivery failure, for a worker that came back', async () => {
    const { writeFromBackground } = stubChrome();
    const result = await mount();

    act(() => result.current.beginCommand('fill')());
    await act(() => writeFromBackground({ ...run, status: 'filling' }));

    expect(result.current.status).toBe('filling');
    expect(failureNotices(result.current)).toEqual([]);
  });

  it('drops a standing optimistic status when the active tab changes', async () => {
    const { knowTab, activate } = stubChrome();
    const result = await mount();
    act(() => result.current.beginCommand('fill'));

    knowTab(2, OTHER_JOB_URL);
    act(() => activate(2));
    await settle();

    expect(result.current.tabId).toBe(2);
    expect(result.current.status).toBeNull();
  });
});

describe('useActiveRun: edits', () => {
  it('applies an edit locally at once, so a controlled textarea never lags a storage round-trip', async () => {
    stubChrome();
    const result = await mount();

    act(() =>
      result.current.edit(run.runId, {
        answers: [{ ...run.answers[0]!, answer: 'Edited.' }],
        jobDescription: 'Senior Engineer at Acme...',
      }),
    );

    expect(result.current.run?.answers[0]!.answer).toBe('Edited.');
  });

  it('discards an edit the store refuses and re-reads the actual run, rather than showing it forever', async () => {
    // The store can refuse an edit this hook already applied optimistically — most often a save
    // that started between the click and the background answering (`lib/run/status.ts`'s
    // `editable`). A refusal writes nothing, so no `chrome.storage.onChanged` event is ever coming
    // to stand the optimism down; this is the one case that has to notice on its own.
    stubChrome({
      sendMessage: (message, callback) => {
        const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
        callback(typedMessage.type === 'UPDATE_RUN' ? { applied: false } : undefined);
      },
    });
    const result = await mount();

    act(() =>
      result.current.edit(run.runId, {
        answers: [{ ...run.answers[0]!, answer: 'Edited.' }],
        jobDescription: 'edited',
      }),
    );

    // Applied locally at once, same as every edit — the refusal hasn't been heard back yet.
    expect(result.current.run?.jobDescription).toBe('edited');

    // Once the refusal lands, the local value reverts to what the store actually holds instead of
    // being preserved indefinitely by the "keep local edits over a stale echo" reconciliation.
    await waitFor(() => expect(result.current.run?.jobDescription).toBe(run.jobDescription));
    expect(result.current.run?.answers[0]!.answer).toBe(run.answers[0]!.answer);

    // The rejected send no longer sits in the pending queue, so it can't swallow a later,
    // successful edit's echo either — confirm the next edit still resolves normally.
    act(() => {
      void setPipelineRun(1, { ...run, jobDescription: 'second attempt' });
    });
    await waitFor(() => expect(result.current.run?.jobDescription).toBe('second attempt'));
  });

  it('keeps a newer in-flight edit when an earlier one is refused, instead of reverting the whole run', async () => {
    // The refusal is about one send, not about everything typed since. Re-reading the store and
    // replacing local state wholesale snapped the textarea back to the pre-edit text and jumped the
    // caret, until the still-unwritten later edit's own echo landed and put it back.
    let updates = 0;
    stubChrome({
      sendMessage: (message, callback) => {
        const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
        if (typedMessage.type !== 'UPDATE_RUN') return callback(undefined);
        // The first edit is refused; the second is still in flight, answered by nothing yet.
        if (updates++ === 0) callback({ applied: false });
      },
    });
    const result = await mount();

    act(() => result.current.edit(run.runId, { answers: run.answers, jobDescription: 'A' }));
    act(() => result.current.edit(run.runId, { answers: run.answers, jobDescription: 'AB' }));

    // Let the refusal's store re-read settle — the point at which the old code clobbered 'AB'.
    await settle();

    expect(result.current.run?.jobDescription).toBe('AB');
  });

  /**
   * A `chrome.runtime.lastError` is not the store speaking: the worker was restarting, or the
   * extension reloading. Nothing decided the edit, so throwing the candidate's typing away is
   * wrong — and silent, since no banner explains where the text went.
   */
  it('keeps an edit nothing answered, rather than reverting typed text on a delivery failure', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount();
    const runtime = chrome.runtime as { lastError: unknown };
    runtime.lastError = { message: 'Could not establish connection.' };
    sendMessage.mockImplementation((_message, callback: (response?: unknown) => void) =>
      callback(),
    );

    act(() =>
      result.current.edit(run.runId, { answers: run.answers, jobDescription: 'typed while dead' }),
    );
    await settle();

    expect(result.current.run?.jobDescription).toBe('typed while dead');

    // And the queue entry is gone, so the next keystroke is sent rather than swallowed as a
    // duplicate of a send that will never be echoed.
    act(() =>
      result.current.edit(run.runId, { answers: run.answers, jobDescription: 'typed while dead!' }),
    );
    await settle();

    expect(callsOfType(sendMessage, 'UPDATE_RUN')).toHaveLength(2);
    expect(result.current.run?.jobDescription).toBe('typed while dead!');
  });

  it('persists an edit, so a reopened panel restores it', async () => {
    stubChrome();
    const result = await mount();

    act(() => result.current.updateAnswer(run.runId, 'f-why', 'Edited.'));
    act(() =>
      result.current.edit(run.runId, {
        answers: result.current.run!.answers,
        jobDescription: 'pasted',
      }),
    );

    // The write is async; wait for it to land before reopening, or the reopen races it.
    await vi.waitFor(async () => expect((await getPipelineRun(1))?.jobDescription).toBe('pasted'));

    const reopened = renderHook(() => useActiveRun(true));
    await waitFor(() => expect(reopened.result.current.run).not.toBeNull());
    expect(reopened.result.current.run).toMatchObject({
      answers: [expect.objectContaining({ answer: 'Edited.' }), expect.anything()],
      jobDescription: 'pasted',
    });
  });

  it('routes edits to the background with the run identity', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount();

    act(() => result.current.edit(run.runId, { answers: run.answers, jobDescription: 'edited' }));

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
    const held = holdEdits();
    stubChrome({ sendMessage: held.sendMessage });
    const result = await mount();

    act(() => result.current.edit(run.runId, { answers: run.answers, jobDescription: 'B' }));
    act(() =>
      result.current.edit(run.runId, { answers: run.answers, jobDescription: run.jobDescription }),
    );

    expect(held.queued.map((message) => message.updates.jobDescription)).toEqual([
      'B',
      run.jobDescription,
    ]);

    await act(() => held.echo(0));
    expect(result.current.run?.jobDescription).toBe(run.jobDescription);
    await act(() => held.echo(1));
    expect((await getPipelineRun(1))?.jobDescription).toBe(run.jobDescription);
  });

  it('refuses an edit for a run the panel is no longer showing', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount();

    act(() =>
      result.current.edit('a-run-from-another-posting', {
        answers: run.answers,
        jobDescription: 'Wrong.',
      }),
    );

    expect(result.current.run?.jobDescription).toBe(run.jobDescription);
    expect(callsOfType(sendMessage, 'UPDATE_RUN')).toHaveLength(0);
  });

  it('refuses an edit while a save is in flight, since that snapshot is already being written', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount(runAt('saving'));

    act(() =>
      result.current.edit(run.runId, { answers: run.answers, jobDescription: 'Too late.' }),
    );

    expect(result.current.run?.jobDescription).toBe(run.jobDescription);
    expect(callsOfType(sendMessage, 'UPDATE_RUN')).toHaveLength(0);
  });

  it("forgets an unechoed edit once the run is replaced, so the new run's progress isn't overwritten", async () => {
    // An edit's echo can be lost — the background replaced the run (Re-analyze) before writing it.
    // Left pending, the dead entry made every later write to the *new* run look like a stale echo,
    // and this panel's old fields were laid over the background's fresh ones.
    const held = holdEdits();
    const { writeFromBackground } = stubChrome({ sendMessage: held.sendMessage });
    const result = await mount();

    act(() =>
      result.current.edit(run.runId, { answers: run.answers, jobDescription: 'never echoed' }),
    );
    await settle();

    const reanalyzed = { ...run, runId: 'run-2', status: 'analyzing' as const, answers: [] };
    await act(() => writeFromBackground(reanalyzed));
    const drafted = [
      { fieldId: 'f-why', question: 'Why us?', answer: 'Fresh draft.', sourceStoryIds: [] },
    ];
    await act(() => writeFromBackground({ ...reanalyzed, status: 'review', answers: drafted }));

    expect(result.current.run?.runId).toBe('run-2');
    expect(result.current.run?.answers).toEqual(drafted);
  });

  it("never writes the background's fields back, so an in-flight run can't be overwritten by this panel", async () => {
    stubChrome();
    // A run mid-Analysis Step, with results the background is the authority on.
    const result = await mount({ ...run, status: 'analyzing', filledFieldCount: 7 });

    act(() => result.current.edit(run.runId, { answers: run.answers, jobDescription: 'pasted' }));

    await vi.waitFor(async () => expect((await getPipelineRun(1))?.jobDescription).toBe('pasted'));
    // The edit landed, and everything the background owns came through untouched.
    expect(await getPipelineRun(1)).toMatchObject({
      jobDescription: 'pasted',
      status: 'analyzing',
      filledFieldCount: 7,
    });
  });
});

describe('useActiveRun.updateAnswer', () => {
  /**
   * Two of these rules are safety rules no rendering path can be relied on to enforce: the Autofill
   * Tab's question card and the Ask Tab's "Use this answer" both reach this, and the Ask Tab's
   * thread can outlive the run it was seeded from.
   */
  it('rewrites the named answer and leaves the others alone', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount(runAt('review'));

    act(() => result.current.updateAnswer('run-1', 'f-why', 'A better answer.'));

    expect(result.current.run?.answers).toEqual([
      expect.objectContaining({ fieldId: 'f-why', answer: 'A better answer.' }),
      expect.objectContaining({ fieldId: 'f-when', answer: 'Soon.' }),
    ]);
    expect(callsOfType(sendMessage, 'UPDATE_RUN')).toEqual([
      [expect.objectContaining({ runId: 'run-1' }), expect.any(Function)],
    ]);
  });

  /**
   * The Ask Tab's thread is seeded from one run and survives the candidate moving to another tab,
   * where the panel is showing a different one. The tab hides "Use this answer" in that state, but
   * hiding a button is a rendering decision — the write itself has to refuse, or a click landing
   * either side of a tab switch writes one posting's answer onto another's.
   */
  it('refuses an answer meant for a run the panel is no longer showing', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount(runAt('review'));

    act(() => result.current.updateAnswer('a-run-from-another-posting', 'f-why', 'Wrong run.'));

    expect(result.current.run?.answers[0]!.answer).toBe('Draft answer.');
    expect(callsOfType(sendMessage, 'UPDATE_RUN')).toHaveLength(0);
  });

  it('refuses while a save is in flight, since that snapshot is already being written', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount(runAt('saving'));

    act(() => result.current.updateAnswer('run-1', 'f-why', 'Too late.'));

    expect(result.current.run?.answers[0]!.answer).toBe('Draft answer.');
    expect(callsOfType(sendMessage, 'UPDATE_RUN')).toHaveLength(0);
  });

  /**
   * A saved record whose answers have since changed is no longer the record that was saved, so the
   * run goes back to `filled` and the candidate is offered the Save Step again.
   */
  it('takes a saved run back to filled, so the edit can be saved over it', async () => {
    stubChrome();
    const result = await mount(runAt('saved'));

    act(() => result.current.updateAnswer('run-1', 'f-why', 'Edited after saving.'));

    await waitFor(() => expect(result.current.status).toBe('filled'));
    expect((await getPipelineRun(1))?.answers[0]!.answer).toBe('Edited after saving.');
  });

  it('leaves a run whose answers it does not recognize untouched', async () => {
    stubChrome();
    const result = await mount(runAt('review'));

    act(() => result.current.updateAnswer('run-1', 'f-not-on-this-form', 'Nowhere to go.'));

    expect(result.current.run?.answers.map((answer) => answer.answer)).toEqual([
      'Draft answer.',
      'Soon.',
    ]);
  });
});

describe('useActiveRun: checking on a step that may have been interrupted', () => {
  // The failure this exists for: Chrome stops the worker mid-Analysis, the request dies (the
  // backend logs a 499), and the checkpoint is left saying `analyzing`. The repair sweep runs when
  // a worker *starts* — and an open panel watching a dead run sends nothing that starts one, so it
  // spins with no error and no retry until the candidate clicks something else.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Mounts on fake timers: the check interval only exists once the store read has rendered. */
  async function mountFrozen(stored: PipelineRunState) {
    await setPipelineRun(1, stored);
    const { result } = renderHook(() => useActiveRun(true));
    await settle();
    expect(result.current.run?.runId).toBe(stored.runId);
    return result;
  }

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it('asks the background to check on a run that claims to still be analyzing', async () => {
    const { sendMessage } = stubChrome();
    await mountFrozen(runAt('analyzing'));

    await advance(15_000);

    expect(callsOfType(sendMessage, 'CHECK_RUN')).toEqual([
      [{ type: 'CHECK_RUN', tabId: 1 }, expect.any(Function)],
    ]);
  });

  it.each(['filling', 'saving'] as const)(
    'checks on an interrupted %s step too',
    async (status) => {
      // Fill and Save are shorter than Analysis but not instant, and both strand the panel the same
      // way — the recovery sweep has a branch for each of them for exactly this reason.
      const { sendMessage } = stubChrome();
      await mountFrozen(runAt(status));

      await advance(15_000);

      expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(1);
    },
  );

  it('leaves a settled run alone, however long the panel stays open', async () => {
    const { sendMessage } = stubChrome();
    await mountFrozen(runAt('review'));

    await advance(120_000);

    expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(0);
  });

  it('stops checking once the step reports it finished', async () => {
    const { sendMessage, writeFromBackground } = stubChrome();
    await mountFrozen(runAt('analyzing'));
    await advance(15_000);
    expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(1);

    await act(() => writeFromBackground(runAt('review')));
    await advance(120_000);

    expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(1);
  });

  it('does not check on a step this panel has only just asked for', async () => {
    // An optimistic status stands for a request in flight from *this* panel. Nothing can have been
    // interrupted yet, and the recovery sweep would demote a run that is about to be written.
    const { sendMessage } = stubChrome();
    const result = await mountFrozen(runAt('review'));
    act(() => result.current.beginCommand('fill'));
    expect(result.current.status).toBe('filling');

    await advance(60_000);

    expect(callsOfType(sendMessage, 'CHECK_RUN')).toHaveLength(0);
  });
});
