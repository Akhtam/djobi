import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFakeBackendClient } from '../lib/backendClient';
import { jobInfo, profile } from '../lib/testFixtures';
import { type AskSeed, useAskThread } from './useAskThread';

const seed: AskSeed = {
  runId: 'run-1',
  fieldId: 'field-7',
  question: 'Tell us about a challenge you faced.',
  currentAnswer: 'A long-winded first draft.',
  token: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useAskThread', () => {
  it('folds a cold opening question out of the wire thread and projects later turns explicitly', async () => {
    const answerChat = vi
      .fn()
      .mockResolvedValueOnce({ reply: 'Here is a draft.', revisedAnswer: 'An answer.' })
      .mockResolvedValueOnce({ reply: 'Shorter now.', revisedAnswer: 'Short.' });
    const client = createFakeBackendClient({ answerChat });
    const { result } = renderHook(() => useAskThread(client, profile, jobInfo, null));

    act(() => result.current.ask('Why us?'));
    await waitFor(() => expect(result.current.turns).toHaveLength(2));

    expect(answerChat).toHaveBeenNthCalledWith(1, {
      profile,
      question: 'Why us?',
      jobInfo,
      currentAnswer: undefined,
      messages: [],
    });
    expect(result.current.turns[0]).toMatchObject({
      role: 'user',
      content: 'Why us?',
      opening: true,
    });

    act(() => result.current.ask('Make it shorter.'));
    await waitFor(() => expect(result.current.turns).toHaveLength(4));

    expect(answerChat.mock.calls[1]![0]!.messages).toEqual([
      { role: 'assistant', content: 'Here is a draft.' },
      { role: 'user', content: 'Make it shorter.' },
    ]);
    expect(answerChat.mock.calls[1]![0]!.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: expect.anything() })]),
    );
  });

  it('snapshots a seeded subject and starts fresh only when a new hand-off token arrives', async () => {
    const answerChat = vi.fn().mockResolvedValue({ reply: 'Shortened.' });
    const client = createFakeBackendClient({ answerChat });
    const otherJob = { ...jobInfo, company: 'Globex', roleTitle: 'Staff Engineer' };
    const { result, rerender } = renderHook(
      ({ currentSeed, currentJob }) => useAskThread(client, profile, currentJob, currentSeed),
      { initialProps: { currentSeed: seed, currentJob: jobInfo } },
    );
    await waitFor(() => expect(result.current.subject?.refining?.runId).toBe('run-1'));

    rerender({ currentSeed: seed, currentJob: otherJob });
    act(() => result.current.ask('Make it shorter.'));
    await waitFor(() => expect(answerChat).toHaveBeenCalledOnce());

    expect(answerChat.mock.calls[0]![0]!).toMatchObject({
      question: seed.question,
      currentAnswer: seed.currentAnswer,
      jobInfo,
      messages: [{ role: 'user', content: 'Make it shorter.' }],
    });

    rerender({
      currentSeed: { ...seed, token: 2, runId: 'run-2' },
      currentJob: otherJob,
    });
    await waitFor(() => expect(result.current.subject?.refining?.runId).toBe('run-2'));

    expect(result.current.subject?.jobInfo).toEqual(otherJob);
    expect(result.current.turns).toEqual([]);
  });

  it('drops an answer from a request a new hand-off superseded', async () => {
    const response = deferred<{ reply: string; revisedAnswer?: string }>();
    const answerChat = vi.fn(() => response.promise);
    const client = createFakeBackendClient({ answerChat });
    const { result, rerender } = renderHook(
      ({ currentSeed }) => useAskThread(client, profile, jobInfo, currentSeed),
      { initialProps: { currentSeed: null as AskSeed | null } },
    );

    act(() => result.current.ask('Why us?'));
    expect(result.current.pending).toBe(true);
    act(() => {
      result.current.ask('This must not send.');
      result.current.retry();
    });
    expect(answerChat).toHaveBeenCalledOnce();

    rerender({ currentSeed: seed });
    await waitFor(() => expect(result.current.subject?.refining?.runId).toBe(seed.runId));
    await act(async () => response.resolve({ reply: 'A stale answer.', revisedAnswer: 'Stale.' }));

    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.turns).toEqual([]);
  });

  it('retries the failed turn without duplicating it and can reset the conversation', async () => {
    const answerChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValueOnce({ reply: 'Second time lucky.', revisedAnswer: 'An answer.' });
    const client = createFakeBackendClient({ answerChat });
    const { result } = renderHook(() => useAskThread(client, profile, jobInfo, seed));
    await waitFor(() => expect(result.current.subject).not.toBeNull());

    act(() => result.current.ask('Make it shorter.'));
    await waitFor(() => expect(result.current.error).toBe('model unavailable'));
    expect(result.current.turns).toHaveLength(1);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.turns).toHaveLength(2));

    expect(answerChat.mock.calls[1]![0]!.messages).toEqual([
      { role: 'user', content: 'Make it shorter.' },
    ]);
    expect(result.current.error).toBeNull();

    act(() => result.current.startOver());
    expect(result.current).toMatchObject({
      subject: null,
      turns: [],
      pending: false,
      error: null,
    });
  });
});
