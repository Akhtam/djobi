/**
 * `useActiveRun` composes the two hooks either side of it, and both of those have their own tests.
 * What is only here is the one operation it adds — rewriting a drafted Question Answer — and the
 * four rules that operation applies. Two of them are safety rules that no rendering path can be
 * relied on to enforce: the Autofill Tab's question card and the Ask Tab's "Use this answer" both
 * reach this, and the Ask Tab's thread can outlive the run it was seeded from.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import { TypedMessageEnvelopeSchema } from '../lib/messages';
import { type PipelineRunState } from '../lib/run';
import { applyPanelEdit, getPipelineRun, setPipelineRun } from '../lib/tabStore/pipelineRun';
import { useActiveRun } from './useActiveRun';
import { pipelineRunFixture } from '../lib/testFixtures';

const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/1';

function runAt(status: PipelineRunState['status']): PipelineRunState {
  return pipelineRunFixture({
    status,
    tabUrl: JOB_URL,
    answers: [
      { fieldId: 'f-why', question: 'Why us?', answer: 'Draft answer.', sourceStoryIds: [] },
      { fieldId: 'f-when', question: 'When can you start?', answer: 'Soon.', sourceStoryIds: [] },
    ],
  });
}

/** A fake Chrome whose `UPDATE_RUN` reaches the store, as the service worker's routing does. */
function stubChrome() {
  return fakeChrome({
    tab: { id: 1, url: JOB_URL },
    sendMessage: (message, callback) => {
      const typedMessage = TypedMessageEnvelopeSchema.parse(message).payload;
      if (typedMessage.type === 'UPDATE_RUN') {
        void applyPanelEdit(typedMessage.tabId, typedMessage.runId, typedMessage.updates).then(
          ({ applied }) => callback({ applied }),
        );
        return;
      }
      callback(undefined);
    },
  });
}

/** Mounts the hook on tab 1 with `run` stored, and waits for it to be showing that run. */
async function mount(run: PipelineRunState) {
  await setPipelineRun(1, run);
  const { result } = renderHook(() => useActiveRun(true));
  await waitFor(() => expect(result.current.run?.runId).toBe(run.runId));
  return result;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useActiveRun.updateAnswer', () => {
  it('rewrites the named answer and leaves the others alone', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount(runAt('review'));

    act(() => result.current.updateAnswer('run-1', 'f-why', 'A better answer.'));

    expect(result.current.run?.answers).toEqual([
      expect.objectContaining({ fieldId: 'f-why', answer: 'A better answer.' }),
      expect.objectContaining({ fieldId: 'f-when', answer: 'Soon.' }),
    ]);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'UPDATE_RUN', runId: 'run-1' }),
      }),
      expect.any(Function),
    );
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

    expect(result.current.run?.answers[0].answer).toBe('Draft answer.');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses while a save is in flight, since that snapshot is already being written', async () => {
    const { sendMessage } = stubChrome();
    const result = await mount(runAt('saving'));

    act(() => result.current.updateAnswer('run-1', 'f-why', 'Too late.'));

    expect(result.current.run?.answers[0].answer).toBe('Draft answer.');
    expect(sendMessage).not.toHaveBeenCalled();
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
    expect((await getPipelineRun(1))?.answers[0].answer).toBe('Edited after saving.');
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
