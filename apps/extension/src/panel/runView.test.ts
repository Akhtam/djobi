import { describe, expect, it } from 'vitest';
import type { UpdateRunOutcome } from '../lib/messages';
import type { PipelineRunState } from '../lib/run';
import type { PipelineRunChange } from '../lib/tabStore/pipelineRun';
import { pipelineRunFixture } from '../lib/testFixtures';
import { createRunView, type RunViewPorts } from './runView';

const run = pipelineRunFixture({
  status: 'review',
  answers: [{ fieldId: 'f-why', question: 'Why us?', answer: 'Draft.', sourceStoryIds: [] }],
});

/**
 * An in-memory store: the test decides what each write looks like to the view (which half of the
 * record moved) and when each `UPDATE_RUN` is answered.
 */
function memoryPorts(initial: PipelineRunState | null) {
  let stored = initial;
  const listeners = new Set<(change: PipelineRunChange) => void>();
  const updates: {
    edits: Pick<PipelineRunState, 'answers' | 'jobDescription'>;
    answer: (outcome: UpdateRunOutcome) => void;
  }[] = [];

  const ports: RunViewPorts = {
    read: () => Promise.resolve(stored),
    subscribe: (_tabId, onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    updateRun: ({ updates: edits }) =>
      new Promise((resolve) => updates.push({ edits, answer: resolve })),
  };

  function write(next: PipelineRunState | null, moved: 'progress' | 'page' | 'edit') {
    const previous = stored;
    stored = next;
    for (const listener of listeners)
      listener({
        previous,
        current: next,
        progressMoved: moved === 'progress',
        pageStateMoved: moved === 'page',
      });
  }

  return { ports, write, updates, setStored: (next: PipelineRunState | null) => (stored = next) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(initial: PipelineRunState | null = run) {
  const store = memoryPorts(initial);
  const view = createRunView(1, store.ports);
  const stop = view.start();
  await settle();
  return { view, stop, ...store };
}

const withAnswer = (answer: string) => ({
  answers: [{ ...run.answers[0]!, answer }],
  jobDescription: run.jobDescription,
});

describe('createRunView', () => {
  it('starts from the stored run', async () => {
    const { view } = await started();
    expect(view.snapshot()).toEqual({ run, pending: null, dispatch: null });
  });

  it('holds an optimistic status through a page-only write, and drops it when progress moves', async () => {
    const { view, write } = await started();

    view.beginCommand('fill');
    write(run, 'page');
    expect(view.snapshot().pending).toBe('filling');

    write({ ...run, status: 'filled' }, 'progress');
    expect(view.snapshot().pending).toBeNull();
  });

  it('holds an optimistic status through its own edit echo', async () => {
    const { view, write } = await started();
    view.beginCommand('fill');

    view.edit(withAnswer('Edited.'));
    write({ ...run, ...withAnswer('Edited.') }, 'edit');

    expect(view.snapshot().pending).toBe('filling');
  });

  it('keeps a newer keystroke when an older one echoes back', async () => {
    const { view, write } = await started();

    view.edit(withAnswer('A'));
    view.edit(withAnswer('AB'));
    write({ ...run, ...withAnswer('A') }, 'edit');

    expect(view.snapshot().run?.answers[0]?.answer).toBe('AB');
  });

  it("ignores a superseded attempt's delivery failure", async () => {
    const { view } = await started();

    const undeliveredFill = view.beginCommand('fill');
    const undeliveredSave = view.beginCommand('save');
    undeliveredFill();
    expect(view.snapshot()).toMatchObject({ pending: 'saving', dispatch: null });

    undeliveredSave();
    expect(view.snapshot()).toMatchObject({
      pending: null,
      dispatch: { status: 'save-error', failure: { step: 'save', kind: 'temporary' } },
    });
  });

  it('re-reads the stored run when the store refuses an edit', async () => {
    const { view, updates } = await started();

    view.edit(withAnswer('Refused.'));
    updates[0]!.answer({ applied: false, delivered: true });
    await settle();

    expect(view.snapshot().run).toEqual(run);
  });

  it('keeps an edit nothing answered', async () => {
    const { view, updates } = await started();

    view.edit(withAnswer('Typed.'));
    updates[0]!.answer({ applied: false, delivered: false });
    await settle();

    expect(view.snapshot().run?.answers[0]?.answer).toBe('Typed.');
  });

  it('discards a read that lands after the view stopped', async () => {
    const store = memoryPorts(run);
    const view = createRunView(1, store.ports);

    view.start()();
    await settle();

    expect(view.snapshot().run).toBeNull();
  });

  it('follows the store again after a stop and restart, as StrictMode does to effects', async () => {
    const store = memoryPorts(run);
    const view = createRunView(1, store.ports);
    view.start()();
    view.start();
    await settle();

    store.write({ ...run, status: 'filled' }, 'progress');

    expect(view.snapshot().run?.status).toBe('filled');
  });

  it('notifies subscribers on every change', async () => {
    const { view, write } = await started();
    let calls = 0;
    view.subscribe(() => ++calls);

    view.beginCommand('fill');
    write({ ...run, status: 'filled' }, 'progress');

    expect(calls).toBe(2);
  });
});
