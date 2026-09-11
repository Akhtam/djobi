import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_PROFILE, type JobInfo, type Profile } from '@djobi/shared';
import { useManualLogFlow, type ManualLogPorts } from './useManualLogFlow.js';

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Platform Engineer',
  seniority: null,
  location: null,
  requirements: [],
  keywords: [],
};

const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe' };

/** A `ManualLogPorts` every test starts from and overrides pieces of. */
function ports(overrides: Partial<ManualLogPorts> = {}): ManualLogPorts {
  return {
    extractJob: vi.fn().mockResolvedValue(jobInfo),
    findApplicationDuplicates: vi.fn().mockResolvedValue({ count: 0, latest: null }),
    save: vi.fn().mockResolvedValue(true),
    handleError: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

describe('useManualLogFlow', () => {
  it('starts in form', () => {
    const { result } = renderHook(() => useManualLogFlow(ports()));
    expect(result.current.state).toEqual({ kind: 'form' });
  });

  it('extracts and lands on extracted, carrying jobInfo, duplicate, and a fresh idempotency key', async () => {
    const client = ports();
    const { result } = renderHook(() => useManualLogFlow(client));

    let returned: JobInfo | null = null;
    await act(async () => {
      returned = await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });

    expect(returned).toEqual(jobInfo);
    expect(result.current.state).toMatchObject({ kind: 'extracted', jobInfo, duplicate: null });
    expect(client.extractJob).toHaveBeenCalledWith('Posting text');
    expect(client.findApplicationDuplicates).toHaveBeenCalledWith(
      'https://example.com/jobs/1',
      undefined,
    );
    if (result.current.state.kind === 'extracted') {
      expect(result.current.state.idempotencyKey).toEqual(expect.any(String));
      expect(result.current.state.idempotencyKey.length).toBeGreaterThan(0);
    }
  });

  it('trims the URL and description once, and never re-reads them after extraction starts', async () => {
    const client = ports();
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('  https://example.com/jobs/1  ', '  Posting text  ');
    });

    expect(client.extractJob).toHaveBeenCalledWith('Posting text');
    expect(client.findApplicationDuplicates).toHaveBeenCalledWith(
      'https://example.com/jobs/1',
      undefined,
    );
    if (result.current.state.kind === 'extracted') {
      expect(result.current.state.source).toEqual({
        jobUrl: 'https://example.com/jobs/1',
        jobDescription: 'Posting text',
      });
    }
  });

  it('a failed Duplicate Guard lookup still reaches extracted — the guard fails open', async () => {
    const client = ports({
      findApplicationDuplicates: vi.fn().mockRejectedValue(new Error('backend hiccup')),
    });
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });

    expect(result.current.state).toMatchObject({ kind: 'extracted', duplicate: null });
  });

  it('reports extract-error with the failure message when nothing claims the error', async () => {
    const client = ports({ extractJob: vi.fn().mockRejectedValue(new Error('model unavailable')) });
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });

    expect(result.current.state).toEqual({
      kind: 'extract-error',
      message: 'model unavailable',
    });
  });

  it('suppresses extract-error when handleError claims the failure', async () => {
    const error = new Error('401');
    const handleError = vi.fn().mockReturnValue(true);
    const client = ports({ extractJob: vi.fn().mockRejectedValue(error), handleError });
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });

    expect(handleError).toHaveBeenCalledWith(error, 'extract');
    expect(result.current.state).not.toMatchObject({ kind: 'extract-error' });
  });

  it('save is a no-op outside extracted/save-error — the port is never called', async () => {
    const client = ports();
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.save(profile, 'Example Labs', 'Platform Engineer');
    });

    expect(client.save).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'form' });
  });

  it('saves from extracted, building the payload from the extraction snapshot, and lands on saved', async () => {
    const client = ports();
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      // Edited after extraction — must not reach the save.
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });
    const idempotencyKey =
      result.current.state.kind === 'extracted' ? result.current.state.idempotencyKey : null;

    await act(async () => {
      await result.current.save(profile, 'Example Labs', 'Platform Engineer');
    });

    expect(result.current.state).toEqual({
      kind: 'saved',
      company: 'Example Labs',
      roleTitle: 'Platform Engineer',
    });
    expect(client.save).toHaveBeenCalledTimes(1);
    const [payload, sentKey] = vi.mocked(client.save).mock.calls[0];
    expect(payload).toMatchObject({
      company: 'Example Labs',
      roleTitle: 'Platform Engineer',
      jobUrl: 'https://example.com/jobs/1',
      rawDescription: 'Posting text',
      source: 'manual',
    });
    expect(sentKey).toBe(idempotencyKey);
  });

  it('reports save-error with a generic message when the port resolves false', async () => {
    const client = ports({ save: vi.fn().mockResolvedValue(false) });
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });
    await act(async () => {
      await result.current.save(profile, 'Example Labs', 'Platform Engineer');
    });

    expect(result.current.state).toMatchObject({ kind: 'save-error' });
  });

  it('reports save-error with the failure message when the port throws', async () => {
    const client = ports({ save: vi.fn().mockRejectedValue(new Error('backend unreachable')) });
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });
    await act(async () => {
      await result.current.save(profile, 'Example Labs', 'Platform Engineer');
    });

    expect(result.current.state).toMatchObject({
      kind: 'save-error',
      message: 'backend unreachable',
    });
  });

  it('suppresses save-error when handleError claims the failure', async () => {
    const handleError = vi.fn().mockReturnValue(true);
    const client = ports({
      save: vi.fn().mockRejectedValue(new Error('401')),
      handleError,
    });
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });
    await act(async () => {
      await result.current.save(profile, 'Example Labs', 'Platform Engineer');
    });

    expect(handleError).toHaveBeenCalledWith(expect.any(Error), 'save');
    expect(result.current.state).not.toMatchObject({ kind: 'save-error' });
  });

  it('a retry from save-error resends the same idempotency key, not a fresh one', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const client = ports({ save });
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });
    await act(async () => {
      await result.current.save(profile, 'Example Labs', 'Platform Engineer');
    });
    expect(result.current.state).toMatchObject({ kind: 'save-error' });

    await act(async () => {
      await result.current.save(profile, 'Example Labs', 'Platform Engineer');
    });
    expect(result.current.state).toMatchObject({ kind: 'saved' });

    const [, firstAttemptKey] = save.mock.calls[0];
    const [, retryKey] = save.mock.calls[1];
    expect(firstAttemptKey).toEqual(expect.any(String));
    expect(retryKey).toBe(firstAttemptKey);
  });

  it('a fresh extraction gets a fresh idempotency key, not the previous one', async () => {
    const client = ports();
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'First posting');
    });
    const firstKey =
      result.current.state.kind === 'extracted' ? result.current.state.idempotencyKey : null;

    act(() => result.current.backToForm());

    await act(async () => {
      await result.current.extract('https://example.com/jobs/2', 'Second posting');
    });
    const secondKey =
      result.current.state.kind === 'extracted' ? result.current.state.idempotencyKey : null;

    expect(firstKey).not.toBeNull();
    expect(secondKey).not.toBeNull();
    expect(secondKey).not.toBe(firstKey);
  });

  it('backToForm returns to form from any state', async () => {
    const client = ports();
    const { result } = renderHook(() => useManualLogFlow(client));

    await act(async () => {
      await result.current.extract('https://example.com/jobs/1', 'Posting text');
    });
    expect(result.current.state).toMatchObject({ kind: 'extracted' });

    act(() => result.current.backToForm());
    expect(result.current.state).toEqual({ kind: 'form' });
  });

  it('shows extracting while the request is in flight', async () => {
    let resolveExtract!: (value: JobInfo) => void;
    const pending = new Promise<JobInfo>((resolve) => {
      resolveExtract = resolve;
    });
    const client = ports({ extractJob: vi.fn().mockReturnValue(pending) });
    const { result } = renderHook(() => useManualLogFlow(client));

    let extraction!: Promise<JobInfo | null>;
    act(() => {
      extraction = result.current.extract('https://example.com/jobs/1', 'Posting text');
    });
    expect(result.current.state).toEqual({ kind: 'extracting' });

    resolveExtract(jobInfo);
    await act(async () => {
      await extraction;
    });
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: 'extracted' }));
  });
});
