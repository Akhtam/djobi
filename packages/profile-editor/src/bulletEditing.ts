import type { WorkExperience } from '@djobi/shared';

/**
 * Toggles one work-experience bullet's starred state, keeping `starredIndices` sorted ascending.
 */
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
 * Parses a bullet-cap number input: empty → `null` (inherit the Profile default); a non-negative
 * integer → itself; anything else → `undefined`, meaning "ignore this keystroke".
 */
export function parseBulletCap(raw: string, valueAsNumber: number): number | null | undefined {
  if (!raw) return null;
  if (Number.isInteger(valueAsNumber) && valueAsNumber >= 0) return valueAsNumber;
  return undefined;
}
