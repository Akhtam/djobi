import type { DuplicateApplicationSummary } from '@djobi/shared';
import { describe, expect, it, vi } from 'vitest';
import { duplicateApplicationOf, findDuplicate } from './duplicateGuard';

const summary: DuplicateApplicationSummary = {
  count: 2,
  latest: {
    id: 'application-2',
    company: 'Acme',
    roleTitle: 'Senior Engineer',
    stage: 'interviewing',
    createdAt: '2026-08-03T10:00:00.000Z',
  },
};

describe('duplicateApplicationOf', () => {
  it('flattens the wire summary without dropping notice fields', () => {
    expect(duplicateApplicationOf(summary)).toEqual({
      ...summary.latest,
      count: 2,
    });
  });

  it('returns null when the wire summary has no latest application', () => {
    expect(duplicateApplicationOf({ count: 0, latest: null })).toBeNull();
  });
});

describe('findDuplicate', () => {
  it('fails open when the advisory lookup is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const backend = {
      findApplicationDuplicates: vi.fn().mockRejectedValue(new Error('backend unavailable')),
    };

    await expect(findDuplicate(backend, 'https://acme.example/jobs/1')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('backend unavailable'));
  });

  it('does not turn the caller cancellation into a successful lookup', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new Error('aborted');
    const backend = { findApplicationDuplicates: vi.fn().mockRejectedValue(failure) };

    await expect(
      findDuplicate(backend, 'https://acme.example/jobs/1', controller.signal),
    ).rejects.toBe(failure);
  });
});
