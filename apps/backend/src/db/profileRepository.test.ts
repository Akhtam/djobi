/**
 * `saveProfile`'s upsert, driven against a stubbed Drizzle client.
 *
 * The route test mocks this whole module away, so which of the two statements runs — and how many
 * round trips that costs — had no coverage at all. The stub below is deliberately thin: it records
 * the calls and returns what the real driver returns (an array of `returning()` rows), which is the
 * only part of Drizzle's behaviour this function's control flow reads.
 */
import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpdate, mockInsert, mockSelect } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockInsert: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('./client.js', () => ({
  db: { update: mockUpdate, insert: mockInsert, select: mockSelect },
}));

const { getProfile, saveProfile } = await import('./profileRepository.js');

const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Jane Doe', email: 'jane@example.com' };

/** `db.update(...).set(...).returning(...)`, resolving with the rows the statement touched. */
function stubUpdate(returnedRows: { id: string }[]) {
  const returning = vi.fn().mockResolvedValue(returnedRows);
  const set = vi.fn().mockReturnValue({ returning });
  mockUpdate.mockReturnValue({ set });
  return { set, returning };
}

/** `db.insert(...).values(...)`. */
function stubInsert() {
  const values = vi.fn().mockResolvedValue(undefined);
  mockInsert.mockReturnValue({ values });
  return { values };
}

beforeEach(() => {
  mockUpdate.mockReset();
  mockInsert.mockReset();
  mockSelect.mockReset();
});

describe('saveProfile', () => {
  it('updates the existing row without asking whether one exists first', async () => {
    const { set } = stubUpdate([{ id: 'profile-1' }]);
    const { values } = stubInsert();

    await expect(saveProfile(profile)).resolves.toEqual(profile);

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ data: profile }));
    expect(values).not.toHaveBeenCalled();
    // The point of the change: one statement on the path that applies after the first ever save.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('inserts the first row when the update touched nothing', async () => {
    stubUpdate([]);
    const { values } = stubInsert();

    await expect(saveProfile(profile)).resolves.toEqual(profile);

    expect(values).toHaveBeenCalledWith({ data: profile });
  });

  it('stamps updatedAt on the update', async () => {
    const { set } = stubUpdate([{ id: 'profile-1' }]);
    stubInsert();

    await saveProfile(profile);

    expect(set.mock.calls[0][0].updatedAt).toBeInstanceOf(Date);
  });
});

describe('getProfile', () => {
  /** `db.select().from(...).limit(1)`. */
  function stubSelect(rows: { data: unknown }[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ limit }) });
  }

  it('resolves null before anything has been saved', async () => {
    stubSelect([]);
    await expect(getProfile()).resolves.toBeNull();
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
