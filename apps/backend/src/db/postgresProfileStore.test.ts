/**
 * Per-user profile persistence, driven against a stubbed Drizzle client.
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

const { BOOTSTRAP_USER_ID } = await import('./bootstrapUser.js');
const { postgresProfileStore } = await import('./postgresProfileStore.js');
const { get: getProfile, save: saveProfile } = postgresProfileStore;

const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe', email: 'jane@example.com' };

/** A second account, to prove `getProfile`/`saveProfile` scope on the `userId` they're given rather
 * than always reaching for the one bootstrap user. */
const SECOND_USER_ID = '00000000-0000-4000-8000-000000000099';

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
  it('upserts under the given user ID in one atomic statement', async () => {
    const { values, onConflictDoUpdate } = stubInsert();

    await expect(saveProfile(BOOTSTRAP_USER_ID, profile)).resolves.toEqual(profile);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith({ userId: BOOTSTRAP_USER_ID, data: profile });
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: expect.anything(),
      set: { data: profile, updatedAt: expect.any(Date) },
    });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("upserts a second user under their own ID, not the first user's", async () => {
    const { values } = stubInsert();

    await saveProfile(SECOND_USER_ID, profile);

    expect(values).toHaveBeenCalledWith({ userId: SECOND_USER_ID, data: profile });
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

  it('selects only the given user ID and resolves null when it is absent', async () => {
    const { where, limit } = stubSelect([]);
    await expect(getProfile(BOOTSTRAP_USER_ID)).resolves.toBeNull();
    expect(where).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
    expect(
      where.mock.calls[0][0].queryChunks.some(
        (chunk: { value?: unknown }) => chunk.value === BOOTSTRAP_USER_ID,
      ),
    ).toBe(true);
  });

  it("never returns a match against a different user's ID", async () => {
    const { where } = stubSelect([]);
    await getProfile(SECOND_USER_ID);
    expect(
      where.mock.calls[0][0].queryChunks.some(
        (chunk: { value?: unknown }) => chunk.value === SECOND_USER_ID,
      ),
    ).toBe(true);
    expect(
      where.mock.calls[0][0].queryChunks.some(
        (chunk: { value?: unknown }) => chunk.value === BOOTSTRAP_USER_ID,
      ),
    ).toBe(false);
  });

  /** The reason this parses rather than casts: jsonb comes back exactly as it was written. */
  it("completes a row written before a field existed, rather than handing back what's stored", async () => {
    const { screeningAnswers: _screeningAnswers, ...withoutScreeningAnswers } = profile;
    stubSelect([{ data: withoutScreeningAnswers }]);

    await expect(getProfile(BOOTSTRAP_USER_ID)).resolves.toEqual(profile);
  });

  it('throws on a row that cannot be read as a Profile', async () => {
    stubSelect([{ data: { fullName: 'Jane Doe' } }]);
    await expect(getProfile(BOOTSTRAP_USER_ID)).rejects.toThrow();
  });
});
