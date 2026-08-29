import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withWorkerKeptAlive } from './keepAlive';

const getPlatformInfo = vi.fn(() => Promise.resolve({}));

describe('withWorkerKeptAlive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getPlatformInfo.mockClear();
    vi.stubGlobal('chrome', { runtime: { getPlatformInfo } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('calls an extension API while the task is in flight, which is the only thing Chrome counts', async () => {
    // A pending `fetch` does not reset the worker's idle timer, so a step made entirely of fetches
    // is indistinguishable from an idle worker until Chrome stops it mid-request.
    let finish!: () => void;
    const task = withWorkerKeptAlive(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('done');
        }),
    );

    expect(getPlatformInfo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(3);

    finish();
    await expect(task).resolves.toBe('done');
  });

  it('stops beating once the task settles, so an idle worker is still allowed to stop', async () => {
    await withWorkerKeptAlive(() => Promise.resolve('done'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });

  it('stops beating when the task rejects, and does not swallow the failure', async () => {
    const failure = new Error('step failed');

    await expect(withWorkerKeptAlive(() => Promise.reject(failure))).rejects.toBe(failure);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });

  it('keeps one heartbeat for overlapping steps, and holds it until the last one finishes', async () => {
    // `tailorResume` and `answerQuestions` are a `Promise.all`, so the first to finish must not
    // clear the beat the other is still relying on.
    let finishSecond!: () => void;
    const first = withWorkerKeptAlive(() => Promise.resolve('first'));
    const second = withWorkerKeptAlive(
      () => new Promise<string>((resolve) => (finishSecond = () => resolve('second'))),
    );

    await expect(first).resolves.toBe('first');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(1);

    finishSecond();
    await expect(second).resolves.toBe('second');
    getPlatformInfo.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });
});
