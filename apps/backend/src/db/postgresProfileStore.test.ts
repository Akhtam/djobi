/**
 * Singleton profile persistence, driven against a stubbed Drizzle client.
 */
import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInsert, mockSelect } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('./client.js', () => ({
  db: { insert: mockInsert, select: mockSelect },
}));

const { PROFILE_ID, postgresProfileStore } = await import('./postgresProfileStore.js');
const { get: getProfile, save: saveProfile } = postgresProfileStore;

const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe', email: 'jane@example.com' };

function stubInsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  mockInsert.mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

beforeEach(() => {
  mockInsert.mockReset();
  mockSelect.mockReset();
});

describe('saveProfile', () => {
  it('uses one atomic upsert statement with the fixed profile ID', async () => {
    const { values, onConflictDoUpdate } = stubInsert();

    await expect(saveProfile(profile)).resolves.toEqual(profile);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith({ id: PROFILE_ID, data: profile });
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: expect.anything(),
      set: { data: profile, updatedAt: expect.any(Date) },
    });
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('getProfile', () => {
  function stubSelect(rows: { data: unknown }[]) {
    // `.limit(1)` is part of the statement under test, not incidental chaining: the row is a
    // primary-key lookup, and the read says so rather than asking for every match and taking one.
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
    return { where, limit };
  }

  it('selects only the fixed profile ID and resolves null when it is absent', async () => {
    const { where, limit } = stubSelect([]);
    await expect(getProfile()).resolves.toBeNull();
    expect(where).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
    expect(
      where.mock.calls[0][0].queryChunks.some(
        (chunk: { value?: unknown }) => chunk.value === PROFILE_ID,
      ),
    ).toBe(true);
  });

  /** The reason this parses rather than casts: jsonb comes back exactly as it was written. */
  it("completes a row written before a field existed, rather than handing back what's stored", async () => {
    const { screeningAnswers: _screeningAnswers, ...withoutScreeningAnswers } = profile;
    stubSelect([{ data: withoutScreeningAnswers }]);

    await expect(getProfile()).resolves.toEqual(profile);
  });

  it('throws on a row that cannot be read as a Profile', async () => {
    stubSelect([{ data: { fullName: 'Jane Doe' } }]);
    await expect(getProfile()).rejects.toThrow();
  });
});
