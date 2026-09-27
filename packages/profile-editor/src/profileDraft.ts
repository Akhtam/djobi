import type {
  Certification,
  ExtractedProfile,
  Profile,
  Project,
  ScreeningAnswers,
  ScreeningTopic,
  WorkExperience,
} from '@djobi/shared';

export type CredentialKind = 'certification' | 'award';

/**
 * Moves a row between `certifications` and `awards`, carrying `name`/`issuer`/`date` and
 * dropping or adding `description`. The row goes to the end of its new list.
 */
export function changeCredentialKind(
  profile: Profile,
  index: number,
  from: CredentialKind,
  to: CredentialKind,
  shared: Pick<Certification, 'name' | 'issuer' | 'date'>,
): Profile {
  if (from === to) return profile;
  if (to === 'award') {
    return {
      ...profile,
      certifications: profile.certifications.filter((_, i) => i !== index),
      awards: [...profile.awards, shared],
    };
  }
  return {
    ...profile,
    awards: profile.awards.filter((_, i) => i !== index),
    certifications: [...profile.certifications, shared],
  };
}

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

/**
 * The list behind a comma-separated input (story tags, project technologies): trimmed, no blanks.
 */
export function commaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** {@link commaList}, but `null` when empty — for fields the Profile stores as nullable. */
export function optionalList(value: string): string[] | null {
  const items = commaList(value);
  return items.length ? items : null;
}

/** {@link spliceWorkBullets} for project bullets, which have no starred indices to remap. */
export function spliceProjectBullets(
  project: Project,
  index: number,
  deleteCount: number,
  ...inserted: string[]
): Project {
  return {
    ...project,
    bullets: [
      ...project.bullets.slice(0, index),
      ...inserted,
      ...project.bullets.slice(index + deleteCount),
    ],
  };
}

/**
 * Appends a skill exactly as typed (no trim or dedupe — altering input is worse than showing it).
 * Empty is refused, since the add button works with the field untouched.
 */
export function addSkill(profile: Profile, skill: string): Profile {
  if (!skill) return profile;
  return { ...profile, skills: [...profile.skills, skill] };
}

/**
 * Removes every chip equal to `skill` — the list is keyed by value, so equal strings are one chip.
 */
export function removeSkill(profile: Profile, skill: string): Profile {
  return { ...profile, skills: profile.skills.filter((entry) => entry !== skill) };
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

/**
 * Copies a resume extraction onto a draft field by field: anything found overwrites, anything null
 * or empty leaves the draft alone. No smart merge — the candidate reviews before saving. Uses `||`
 * so an extracted `''` counts as nothing found.
 */
export function applyExtractedProfile(profile: Profile, extracted: ExtractedProfile): Profile {
  return {
    ...profile,
    fullName: extracted.fullName || profile.fullName,
    email: extracted.email || profile.email,
    phone: extracted.phone || profile.phone,
    location: extracted.location || profile.location,
    links: {
      linkedin: extracted.links.linkedin || profile.links.linkedin,
      portfolio: extracted.links.portfolio || profile.links.portfolio,
      github: extracted.links.github || profile.links.github,
    },
    summary: extracted.summary || profile.summary,
    // Extracted roles carry no selection controls, so each gets the same defaults as a new role.
    workExperience: extracted.workExperience.length
      ? extracted.workExperience.map((role) => ({
          ...role,
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        }))
      : profile.workExperience,
    education: extracted.education.length ? extracted.education : profile.education,
    skills: extracted.skills.length ? extracted.skills : profile.skills,
    projects: extracted.projects.length ? extracted.projects : profile.projects,
    certifications: extracted.certifications.length
      ? extracted.certifications
      : profile.certifications,
    awards: extracted.awards.length ? extracted.awards : profile.awards,
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
        const bullet = entry.bullets[index];
        if (bullet !== undefined && !bullet.trim()) {
          normalized = spliceWorkBullets(normalized, index, 1);
        }
      }
      return normalized;
    }),
    // No starred-index bookkeeping here, unlike work experience: a project has no starring concept
    // to remap, so a plain filter is the whole operation.
    projects: profile.projects.map((project) => ({
      ...project,
      bullets: project.bullets.filter((bullet) => bullet.trim()),
    })),
    stories,
  };
}
