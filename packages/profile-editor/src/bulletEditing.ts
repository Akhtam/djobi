import type { WorkExperience } from '@djobi/shared';

/** Toggles one work-experience bullet's starred state, keeping `starredIndices` sorted ascending. */
export function toggleStarredBullet(entry: WorkExperience, bulletIndex: number): WorkExperience {
  const isStarred = entry.starredIndices.includes(bulletIndex);
  return {
    ...entry,
    starredIndices: isStarred
      ? entry.starredIndices.filter((star) => star !== bulletIndex)
      : [...entry.starredIndices, bulletIndex].sort((a, b) => a - b),
  };
}

/**
 * Parses a bullet-cap `<input type="number">`'s raw text against its own `valueAsNumber` reading.
 *
 * Empty clears the cap (inherit the Profile default) — `null`. Anything that isn't a non-negative
 * integer is rejected as `undefined`, which a caller reads as "ignore this keystroke": the same
 * silent rejection the field gave a value like `-1` or `1.5` before this existed, so a bad
 * keystroke leaves the input showing whatever the entry's cap already was rather than a value nothing
 * saved.
 */
export function parseBulletCap(raw: string, valueAsNumber: number): number | null | undefined {
  if (!raw) return null;
  if (Number.isInteger(valueAsNumber) && valueAsNumber >= 0) return valueAsNumber;
  return undefined;
}
