import type { Profile, WorkExperience } from './schemas.js';
import type { ScreeningAnswers, ScreeningTopic } from './screeningAnswers.js';

/** Omits a cleared answer instead of storing an answered-but-empty topic. */
export function withScreeningAnswer(
  answers: ScreeningAnswers,
  topic: ScreeningTopic,
  value: string,
): ScreeningAnswers {
  if (!value.trim()) {
    const { [topic]: _removed, ...rest } = answers;
    return rest;
  }
  return { ...answers, [topic]: value };
}

/** Represents a cleared optional input consistently with the Profile schema. */
export function optionalText(value: string): string | null {
  return value.trim() ? value : null;
}

export function storyTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Applies one bullet-list splice and keeps source-index stars attached to the same bullets. */
export function spliceWorkBullets(
  entry: WorkExperience,
  index: number,
  deleteCount: number,
  ...inserted: string[]
): WorkExperience {
  const deletedEnd = index + deleteCount;
  const shift = inserted.length - deleteCount;
  const starredIndices = entry.starredIndices.flatMap((starredIndex) => {
    if (starredIndex < index) return [starredIndex];
    if (starredIndex < deletedEnd) return [];
    return [starredIndex + shift];
  });

  return {
    ...entry,
    bullets: [...entry.bullets.slice(0, index), ...inserted, ...entry.bullets.slice(deletedEnd)],
    starredIndices,
  };
}

/** Normalizes transient form values into the Profile shape persisted by the backend. */
export function normalizeProfileDraft(profile: Profile, createStoryId: () => string): Profile {
  const idCounts = new Map<string, number>();
  const usedIds = new Set<string>();
  for (const story of profile.stories) {
    if (story.id.trim()) {
      idCounts.set(story.id, (idCounts.get(story.id) ?? 0) + 1);
      usedIds.add(story.id);
    }
  }

  const stories = profile.stories.map((story) => {
    if (story.id.trim() && idCounts.get(story.id) === 1) return story;

    let id = createStoryId();
    while (usedIds.has(id)) id = createStoryId();
    usedIds.add(id);
    return { ...story, id };
  });

  return {
    ...profile,
    workExperience: profile.workExperience.map((entry) => {
      let normalized = entry;
      for (let index = entry.bullets.length - 1; index >= 0; --index) {
        if (!entry.bullets[index].trim()) normalized = spliceWorkBullets(normalized, index, 1);
      }
      return normalized;
    }),
    stories,
  };
}
