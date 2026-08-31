import type { Profile, ScreeningAnswers, ScreeningTopic } from '@djobi/shared';

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
    workExperience: profile.workExperience.map((entry) => ({
      ...entry,
      bullets: entry.bullets.filter((bullet) => bullet.trim() !== ''),
    })),
    stories,
  };
}
